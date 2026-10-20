package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"

	"fiatjaf.com/nostr"
)

func privatePostFixture(t *testing.T) (*Storage, *AccountPublisher, *InvoiceManager, *nostr.Event) {
	t.Helper()
	t.Setenv("ENABLE_POST_CREATION", "true")
	s, publisher, note := accountPublicationFixture(t, "wss://one.example", "wss://two.example")
	note.Tags = nostr.Tags{{"L", anonymousNamespace}, {"l", "anonymous", anonymousNamespace}}
	if err := signEvent(note, generatePrivateKey()); err != nil {
		t.Fatal(err)
	}
	monitor := NewPaymentMonitor(s, publisher.relayPubkey, NewPostFetcher(nil), NewLNURLResolver())
	monitor.accountPublisher = publisher
	manager := NewInvoiceManager(NewMockLightningBackend(), s, monitor, 21)
	return s, publisher, manager, note
}

func TestPrivatePostInvoiceSurvivesRestartAndPublishesAfterPayment(t *testing.T) {
	s, publisher, manager, note := privatePostFixture(t)
	share := 0
	handler := PromoteHandler(s, manager, NewPostFetcher(nil))
	response := postPromote(t, handler, promoteRequest{Event: note, AmountSats: 21, AuthorShare: &share}, "1.2.3.4")
	if response.Code != http.StatusOK {
		t.Fatalf("invoice: %d %s", response.Code, response.Body)
	}
	var invoice promoteResponse
	if err := json.Unmarshal(response.Body.Bytes(), &invoice); err != nil {
		t.Fatal(err)
	}
	if s.HasPost(note.ID.Hex()) || len(s.PendingAccountPublications()) != 0 {
		t.Fatal("unpaid post became public")
	}
	// An ID-only preview cannot recover a private invoice snapshot.
	preview := PreviewHandler(s, NewPostFetcher(nil))
	privateResponse := postPromote(t, preview, map[string]any{"event": note}, "1.2.3.5")
	if privateResponse.Code != 200 {
		t.Fatalf("private preview: %s", privateResponse.Body)
	}
	lookup := postPromote(t, preview, map[string]any{"note": note.ID.Hex()}, "1.2.3.6")
	if lookup.Code == 200 {
		t.Fatal("private preview entered the shared ID cache")
	}
	// Recovery has no browser or guest secret. Only the exact signed snapshot.
	reloaded, err := NewStorage(s.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	publisher.storage = reloaded
	manager.paymentMonitor.storage = reloaded
	if err := manager.paymentMonitor.ProcessInvoicePayment(invoice.PaymentHash, 9999); err != nil {
		t.Fatal(err)
	}
	if err := manager.paymentMonitor.ProcessInvoicePayment(invoice.PaymentHash, 9999); err != nil {
		t.Fatal(err)
	}
	post, ok := reloaded.GetPost(note.ID.Hex())
	if !ok || post.TotalSatsPaid != 21 || !reflect.DeepEqual(note, post.Event) {
		t.Fatalf("settlement did not preserve snapshot: %+v", post)
	}
	var mu sync.Mutex
	sent := map[string][]string{}
	publisher.publish = func(_ context.Context, relay string, event *nostr.Event) error {
		mu.Lock()
		defer mu.Unlock()
		sent[relay] = append(sent[relay], event.ID.Hex())
		return nil
	}
	if pending := publisher.publishPending(context.Background()); pending != 0 {
		t.Fatalf("%d deliveries pending", pending)
	}
	quote, _ := reloaded.QuotePublication(note.ID.Hex())
	for _, target := range publisher.Targets() {
		if len(sent[target]) < 2 || sent[target][0] != note.ID.Hex() || sent[target][len(sent[target])-1] != quote.Event.ID.Hex() {
			t.Fatalf("wrong delivery order: %v", sent)
		}
	}
}

func TestPrivatePostValidationAndAuthorAttribution(t *testing.T) {
	s, _, manager, note := privatePostFixture(t)
	share := 20
	for _, req := range []promoteRequest{
		{Event: note, AmountSats: 21},
		{Event: note, AmountSats: 21, AuthorShare: &share},
		{Event: note, Note: fmt.Sprintf("%064d", 1), AmountSats: 21},
	} {
		r := postPromote(t, PromoteHandler(s, manager, nil), req, "1.2.3.4")
		if r.Code != 400 {
			t.Fatalf("accepted invalid draft: %d %s", r.Code, r.Body)
		}
	}
	changed := *note
	changed.Content = "Forged content"
	if err := validateDraftEvent(&changed, ""); err == nil {
		t.Fatal("accepted a modified signed post")
	}
	if anonymousPost(&nostr.Event{Tags: nostr.Tags{{"l", "anonymous", anonymousNamespace}}}) {
		t.Fatal("accepted a label without its namespace")
	}
	if !anonymousPost(note) {
		t.Fatal("lost signed guest label")
	}
}

func TestPrivatePostQuoteDependencyAndRemoval(t *testing.T) {
	s, publisher, manager, note := privatePostFixture(t)
	zero := 0
	invoice, err := manager.GenerateDraftInvoice(context.Background(), note, 21, nil, nil, &zero, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.paymentMonitor.ProcessInvoicePayment(invoice.PaymentHash, 21); err != nil {
		t.Fatal(err)
	}
	quote, _ := s.QuotePublication(note.ID.Hex())
	late := "wss://late.example"
	if err := s.ExtendAccountPublicationTargets(quotePublicationKey(note.ID.Hex()), quote.Event.ID.Hex(), []string{late}); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	sent := map[string][]string{}
	failRoot := true
	publisher.publish = func(_ context.Context, target string, event *nostr.Event) error {
		mu.Lock()
		defer mu.Unlock()
		if event.ID == note.ID && failRoot {
			return fmt.Errorf("offline")
		}
		sent[target] = append(sent[target], event.ID.Hex())
		return nil
	}
	if publisher.publishPending(context.Background()) == 0 {
		t.Fatal("lost pending root dependency")
	}
	if len(sent) != 0 {
		t.Fatal("quote escaped before its original")
	}
	failRoot = false
	if publisher.publishPending(context.Background()) != 0 {
		t.Fatal("retry did not drain")
	}
	if len(sent[late]) != 2 || sent[late][0] != note.ID.Hex() {
		t.Fatalf("late target lost dependency: %v", sent[late])
	}
	if _, err := publisher.RemovePost(note.ID.Hex()); err != nil {
		t.Fatal(err)
	}
	root, _ := s.accountPublication(originalPublicationKey(note.ID.Hex()))
	if !root.Cancelled {
		t.Fatal("operator removal did not cancel original")
	}
	for _, job := range s.PendingAccountPublications() {
		if job.Record.Type != accountPublicationDeletion {
			t.Fatalf("removed note still has pending %s", job.Record.Type)
		}
	}
}

func TestPrivatePostSupportNeedsNoPublicLookup(t *testing.T) {
	s, _, _, note := privatePostFixture(t)
	support := NewAuthorSupport(s, NewPostFetcher(nil))
	encoded, _ := json.Marshal(map[string]any{"event": note})
	req := httptest.NewRequest("POST", "/api/support", bytes.NewReader(encoded))
	r := httptest.NewRecorder()
	support.Handler()(r, req)
	if r.Code != 200 {
		t.Fatalf("support failed: %d %s", r.Code, r.Body)
	}
	var endpoint authorEndpoint
	if err := json.Unmarshal(r.Body.Bytes(), &endpoint); err != nil {
		t.Fatal(err)
	}
	if endpoint.Author != note.PubKey.Hex() || endpoint.ReasonCode != "no_address" {
		t.Fatalf("wrong guest support: %+v", endpoint)
	}
}

func TestPrivateQuotePaymentDoesNotBoostItsSource(t *testing.T) {
	s, _, manager, note := privatePostFixture(t)
	sourceID := seedPromotedPost(t, s, generatePrivateKey())
	source, _ := s.GetPost(sourceID)
	before := source.TotalSatsPaid
	note.Tags = append(note.Tags, nostr.Tag{"q", sourceID, "", source.Event.PubKey.Hex()})
	if err := signEvent(note, generatePrivateKey()); err != nil {
		t.Fatal(err)
	}
	zero := 0
	response := postPromote(t, PromoteHandler(s, manager, NewPostFetcher(nil)), promoteRequest{Event: note, AmountSats: 21, AuthorShare: &zero}, "1.2.3.4")
	if response.Code != 200 {
		t.Fatalf("quote invoice: %d %s", response.Code, response.Body)
	}
	var invoice promoteResponse
	if err := json.Unmarshal(response.Body.Bytes(), &invoice); err != nil {
		t.Fatal(err)
	}
	if invoice.NoteID == sourceID {
		t.Fatal("quote invoice targeted its source")
	}
	if err := manager.paymentMonitor.ProcessInvoicePayment(invoice.PaymentHash, 21); err != nil {
		t.Fatal(err)
	}
	source, _ = s.GetPost(sourceID)
	if source.TotalSatsPaid != before {
		t.Fatal("quote payment changed source ranking")
	}
	root, _ := s.accountPublication(originalPublicationKey(note.ID.Hex()))
	if len(root.Recipients) != 1 || root.Recipients[0] != source.Event.PubKey.Hex() {
		t.Fatal("lost verified quote recipient")
	}
	note.Tags[len(note.Tags)-1][3] = note.PubKey.Hex()
	if err := signEvent(note, generatePrivateKey()); err != nil {
		t.Fatal(err)
	}
	bad := postPromote(t, PromoteHandler(s, manager, NewPostFetcher(nil)), promoteRequest{Event: note, AmountSats: 21, AuthorShare: &zero}, "1.2.3.5")
	if bad.Code != 400 {
		t.Fatal("trusted an unverified quote author")
	}
}

func TestPrivatePostCreationRollbackKeepsIssuedInvoiceRecovery(t *testing.T) {
	s, _, manager, note := privatePostFixture(t)
	zero := 0
	if _, err := manager.GenerateDraftInvoice(context.Background(), note, 21, nil, nil, &zero, nil); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ENABLE_POST_CREATION", "false")
	if !draftAdmissionEnabled(s, note) {
		t.Fatal("rollback stranded an issued invoice")
	}
	other := cloneNostrEvent(note)
	other.Content = "Another post"
	if err := signEvent(other, generatePrivateKey()); err != nil {
		t.Fatal(err)
	}
	if draftAdmissionEnabled(s, other) {
		t.Fatal("rollback admitted a fresh post")
	}
	response := postPromote(t, PreviewHandler(s, nil), map[string]any{"event": note}, "1.2.3.4")
	if response.Code != 200 {
		t.Fatal("rollback could not preview its own supplied invoice snapshot")
	}
}

func TestPrivatePostFailedCommitKeepsInvoiceWithoutPublishing(t *testing.T) {
	s, publisher, manager, note := privatePostFixture(t)
	zero := 0
	invoice, err := manager.GenerateDraftInvoice(context.Background(), note, 21, nil, nil, &zero, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.dataFile = t.TempDir() // Atomic file replacement cannot replace a directory.
	if err := manager.paymentMonitor.ProcessInvoicePayment(invoice.PaymentHash, 21); err == nil {
		t.Fatal("failed storage commit reported success")
	}
	if s.HasPost(note.ID.Hex()) || len(s.PendingAccountPublications()) != 0 {
		t.Fatal("partial settlement escaped failed transaction")
	}
	if _, ok := s.GetPendingInvoice(invoice.PaymentHash); !ok {
		t.Fatal("failed commit lost pending invoice")
	}
	publisher.publish = func(context.Context, string, *nostr.Event) error {
		t.Fatal("uncommitted original was sent")
		return nil
	}
	publisher.publishPending(context.Background())
}
