package main

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip19"
)

func accountPublicationFixture(t *testing.T, targets ...string) (*Storage, *AccountPublisher, *nostr.Event) {
	t.Helper()
	storage := newTestStorage(t)
	privkey := nostr.GeneratePrivateKey()
	pubkey, err := nostr.GetPublicKey(privkey)
	if err != nil {
		t.Fatal(err)
	}
	publisher, err := NewAccountPublisher(storage, pubkey, privkey, "https://board.example/", targets)
	if err != nil {
		t.Fatal(err)
	}
	note := &nostr.Event{Kind: 1, CreatedAt: nostr.Now(), Tags: nostr.Tags{}, Content: "Worth sharing"}
	if err := note.Sign(nostr.GeneratePrivateKey()); err != nil {
		t.Fatal(err)
	}
	return storage, publisher, note
}

func tagByName(event *nostr.Event, name string) nostr.Tag {
	for _, tag := range event.Tags {
		if len(tag) > 0 && tag[0] == name {
			return tag
		}
	}
	return nil
}

func TestBuildPromotionQuote(t *testing.T) {
	_, publisher, note := accountPublicationFixture(t, "wss://one.example")
	quote, err := publisher.BuildQuote(note, "wss://source.example")
	if err != nil {
		t.Fatal(err)
	}
	if quote.Kind != 1 || quote.PubKey != publisher.relayPubkey {
		t.Fatalf("quote identity kind=%d pubkey=%s", quote.Kind, quote.PubKey)
	}
	if ok, err := quote.CheckSignature(); err != nil || !ok {
		t.Fatalf("invalid quote signature: valid=%v err=%v", ok, err)
	}
	q := tagByName(quote, "q")
	wantQ := nostr.Tag{"q", note.ID, "wss://source.example", note.PubKey}
	if fmt.Sprint(q) != fmt.Sprint(wantQ) {
		t.Fatalf("q tag=%v, want %v", q, wantQ)
	}
	p := tagByName(quote, "p")
	if len(p) != 2 || p[1] != note.PubKey {
		t.Fatalf("p tag=%v, want author %s", p, note.PubKey)
	}
	if tagByName(quote, "e") != nil {
		t.Fatal("top-level quote must not be marked as a reply")
	}
	parts := strings.Split(quote.Content, "\n\n")
	if len(parts) != 3 || parts[0] != promotionQuoteCopy || parts[1] != "https://board.example" {
		t.Fatalf("unexpected quote copy: %q", quote.Content)
	}
	prefix, decoded, err := nip19.Decode(strings.TrimPrefix(parts[2], "nostr:"))
	if err != nil || prefix != "nevent" {
		t.Fatalf("quote reference is not an nevent: prefix=%q err=%v", prefix, err)
	}
	pointer := decoded.(nostr.EventPointer)
	if pointer.ID != note.ID || pointer.Author != note.PubKey || len(pointer.Relays) != 1 || pointer.Relays[0] != "wss://source.example" {
		t.Fatalf("quote pointer=%+v", pointer)
	}
}

func TestPublicBoardURLValidation(t *testing.T) {
	for _, invalid := range []string{"board.example", "ftp://board.example", "https://"} {
		if _, err := normalizePublicBoardURL(invalid); err == nil {
			t.Errorf("accepted invalid URL %q", invalid)
		}
	}
	for input, want := range map[string]string{
		"":                         "",
		" https://board.example/ ": "https://board.example",
		"http://localhost:8080":    "http://localhost:8080",
	} {
		got, err := normalizePublicBoardURL(input)
		if err != nil || got != want {
			t.Errorf("normalizePublicBoardURL(%q)=%q, %v; want %q", input, got, err, want)
		}
	}
}

func TestFirstPaymentQueuesOneDurableQuote(t *testing.T) {
	storage, publisher, note := accountPublicationFixture(t, "wss://one.example", "wss://one.example", "wss://two.example")
	first, err := publisher.BuildQuote(note, "")
	if err != nil {
		t.Fatal(err)
	}
	credited, err := storage.CreditZapWithPublication(note.ID, 21, note, "zap-one", "hash-one", first, publisher.Targets())
	if err != nil || !credited {
		t.Fatalf("first credit: credited=%v err=%v", credited, err)
	}
	record, ok := storage.QuotePublication(note.ID)
	if !ok || record.Event.ID != first.ID || len(record.Targets) != 2 {
		t.Fatalf("first quote record=%+v", record)
	}

	second, err := publisher.BuildQuote(note, "wss://different.example")
	if err != nil {
		t.Fatal(err)
	}
	credited, err = storage.CreditZapWithPublication(note.ID, 5, note, "zap-two", "hash-two", second, publisher.Targets())
	if err != nil || !credited {
		t.Fatalf("boost credit: credited=%v err=%v", credited, err)
	}
	record, _ = storage.QuotePublication(note.ID)
	if record.Event.ID != first.ID {
		t.Fatalf("boost replaced quote %s with %s", first.ID, record.Event.ID)
	}

	reloaded, err := NewStorage(storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	record, ok = reloaded.QuotePublication(note.ID)
	if !ok || record.Event.ID != first.ID {
		t.Fatal("quote did not survive reload")
	}
}

func TestInvoiceSettlementQueuesQuoteThroughPaymentMonitor(t *testing.T) {
	storage, publisher, note := accountPublicationFixture(t, "wss://one.example")
	invoice := &PendingInvoice{
		PostID: note.ID, PaymentHash: "invoice-hash", AmountSats: 34,
		Event: note, RelayHints: []string{"wss://source.example"}, Author: note.PubKey,
	}
	if err := storage.AddPendingInvoice(invoice); err != nil {
		t.Fatal(err)
	}
	monitor := NewPaymentMonitor(storage, publisher.relayPubkey, NewPostFetcher(nil), seedResolver())
	monitor.SetAccountPublisher(publisher)
	if err := monitor.ProcessInvoicePayment(invoice.PaymentHash, invoice.AmountSats); err != nil {
		t.Fatal(err)
	}
	record, ok := storage.QuotePublication(note.ID)
	if !ok || record.Event == nil || firstTag(record.Event, "q") != note.ID {
		t.Fatalf("invoice settlement did not queue quote: %+v", record)
	}
	if err := monitor.ProcessInvoicePayment(invoice.PaymentHash, invoice.AmountSats); err != nil {
		t.Fatal(err)
	}
	if len(storage.accountPublications) != 1 {
		t.Fatalf("duplicate settlement created %d publications", len(storage.accountPublications))
	}
}

func TestAccountOutboxRetriesOnlyUndeliveredRelaysWithSameEvent(t *testing.T) {
	storage, publisher, note := accountPublicationFixture(t, "wss://one.example", "wss://two.example")
	quote, err := publisher.BuildQuote(note, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.CreditZapWithPublication(note.ID, 21, note, "zap", "hash", quote, publisher.Targets()); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	calls := map[string][]string{}
	allowSecond := false
	publisher.publish = func(_ context.Context, relay string, event *nostr.Event) error {
		mu.Lock()
		defer mu.Unlock()
		calls[relay] = append(calls[relay], event.ID)
		if relay == "wss://two.example" && !allowSecond {
			return fmt.Errorf("temporarily unavailable")
		}
		return nil
	}
	if remaining := publisher.publishPending(context.Background()); remaining != 1 {
		t.Fatalf("remaining=%d, want 1", remaining)
	}
	record, _ := storage.QuotePublication(note.ID)
	if len(record.Delivered) != 1 || record.Delivered[0] != "wss://one.example" {
		t.Fatalf("delivered=%v", record.Delivered)
	}

	reloaded, err := NewStorage(storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	publisher.storage = reloaded
	allowSecond = true
	if remaining := publisher.publishPending(context.Background()); remaining != 0 {
		t.Fatalf("remaining=%d, want 0", remaining)
	}
	if len(calls["wss://one.example"]) != 1 || len(calls["wss://two.example"]) != 2 {
		t.Fatalf("unexpected relay attempts: %v", calls)
	}
	for relay, ids := range calls {
		for _, id := range ids {
			if id != quote.ID {
				t.Fatalf("%s received changing event id %s, want %s", relay, id, quote.ID)
			}
		}
	}
}

func TestConcurrentFirstPaymentsQueueOneQuote(t *testing.T) {
	storage, publisher, note := accountPublicationFixture(t, "wss://one.example")
	quote, err := publisher.BuildQuote(note, "")
	if err != nil {
		t.Fatal(err)
	}

	const payments = 16
	errors := make(chan error, payments)
	var workers sync.WaitGroup
	for i := 0; i < payments; i++ {
		workers.Add(1)
		go func(i int) {
			defer workers.Done()
			_, err := storage.CreditZapWithPublication(
				note.ID, 1, note, fmt.Sprintf("zap-%d", i), fmt.Sprintf("hash-%d", i), quote, publisher.Targets(),
			)
			errors <- err
		}(i)
	}
	workers.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	post, _ := storage.GetPost(note.ID)
	if post.TotalSatsPaid != payments {
		t.Fatalf("total=%d, want %d", post.TotalSatsPaid, payments)
	}
	record, ok := storage.QuotePublication(note.ID)
	if !ok || record.Event.ID != quote.ID || len(storage.accountPublications) != 1 {
		t.Fatalf("concurrent quote record=%+v publications=%d", record, len(storage.accountPublications))
	}
}

func TestDeliverySaveFailureRetriesSameEvent(t *testing.T) {
	storage, publisher, note := accountPublicationFixture(t, "wss://one.example")
	quote, err := publisher.BuildQuote(note, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.CreditZapWithPublication(note.ID, 21, note, "zap", "hash", quote, publisher.Targets()); err != nil {
		t.Fatal(err)
	}

	var ids []string
	publisher.publish = func(_ context.Context, _ string, event *nostr.Event) error {
		ids = append(ids, event.ID)
		return nil
	}
	path := storage.dataFile
	storage.dataFile = filepath.Join(t.TempDir(), "missing", "board.json")
	if remaining := publisher.publishPending(context.Background()); remaining != 1 {
		t.Fatalf("failed save left remaining=%d, want 1", remaining)
	}
	storage.dataFile = path
	if remaining := publisher.publishPending(context.Background()); remaining != 0 {
		t.Fatalf("retry left remaining=%d", remaining)
	}
	if len(ids) != 2 || ids[0] != ids[1] || ids[0] != quote.ID {
		t.Fatalf("retry event ids=%v, want %s twice", ids, quote.ID)
	}
}

func TestPaymentAndQuoteRollBackTogether(t *testing.T) {
	storage, publisher, note := accountPublicationFixture(t, "wss://one.example")
	quote, err := publisher.BuildQuote(note, "")
	if err != nil {
		t.Fatal(err)
	}
	path := storage.dataFile
	storage.dataFile = filepath.Join(t.TempDir(), "missing", "board.json")
	if _, err := storage.CreditZapWithPublication(note.ID, 21, note, "zap", "hash", quote, publisher.Targets()); err == nil {
		t.Fatal("expected save failure")
	}
	if _, ok := storage.GetPost(note.ID); ok {
		t.Fatal("failed save left promoted post")
	}
	if _, ok := storage.QuotePublication(note.ID); ok {
		t.Fatal("failed save left quote outbox record")
	}
	if storage.IsZapProcessed("zap") {
		t.Fatal("failed save left zap deduplication marker")
	}
	storage.dataFile = path
}

func TestInvoiceAndQuoteRollBackTogether(t *testing.T) {
	storage, publisher, note := accountPublicationFixture(t, "wss://one.example")
	quote, err := publisher.BuildQuote(note, "")
	if err != nil {
		t.Fatal(err)
	}
	invoice := &PendingInvoice{PostID: note.ID, PaymentHash: "invoice-hash", AmountSats: 21, Event: note}
	if err := storage.AddPendingInvoice(invoice); err != nil {
		t.Fatal(err)
	}
	path := storage.dataFile
	storage.dataFile = filepath.Join(t.TempDir(), "missing", "board.json")
	if _, err := storage.SettleInvoiceWithPublication(invoice.PaymentHash, note, quote, publisher.Targets()); err == nil {
		t.Fatal("expected save failure")
	}
	if _, ok := storage.GetPost(note.ID); ok {
		t.Fatal("failed settlement left promoted post")
	}
	if _, ok := storage.GetPendingInvoice(invoice.PaymentHash); !ok {
		t.Fatal("failed settlement lost pending invoice")
	}
	if _, ok := storage.QuotePublication(note.ID); ok {
		t.Fatal("failed settlement left quote")
	}
	if _, ok := storage.InvoiceReceipt(invoice.PaymentHash); ok {
		t.Fatal("failed settlement left receipt")
	}
	storage.dataFile = path
}

func TestRemovalQueuesDeletionAndRestoreDoesNotQuoteAgain(t *testing.T) {
	storage, publisher, note := accountPublicationFixture(t, "wss://one.example", "wss://two.example")
	quote, err := publisher.BuildQuote(note, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.CreditZapWithPublication(note.ID, 21, note, "zap-one", "hash-one", quote, publisher.Targets()); err != nil {
		t.Fatal(err)
	}
	if _, err := publisher.RemovePost(note.ID); err != nil {
		t.Fatal(err)
	}
	quoteRecord, _ := storage.QuotePublication(note.ID)
	if !quoteRecord.Cancelled {
		t.Fatal("removal did not cancel pending quote")
	}
	deletion := storage.accountPublications[deletionPublicationKey(quote.ID)]
	if deletion == nil || deletion.Event == nil || deletion.Event.Kind != 5 {
		t.Fatalf("deletion record=%+v", deletion)
	}
	if firstTag(deletion.Event, "e") != quote.ID || firstTag(deletion.Event, "k") != "1" || deletion.Event.Content != "" {
		t.Fatalf("invalid deletion event: %+v", deletion.Event)
	}
	if ok, err := deletion.Event.CheckSignature(); err != nil || !ok {
		t.Fatalf("invalid deletion signature: valid=%v err=%v", ok, err)
	}
	pending := storage.PendingAccountPublications()
	if len(pending) != 1 || pending[0].Record.Type != accountPublicationDeletion || len(pending[0].Pending) != 2 {
		t.Fatalf("pending after removal=%+v", pending)
	}

	if err := publisher.RestorePost(note.ID); err != nil {
		t.Fatal(err)
	}
	newQuote, err := publisher.BuildQuote(note, "wss://other.example")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.CreditZapWithPublication(note.ID, 7, note, "zap-two", "hash-two", newQuote, publisher.Targets()); err != nil {
		t.Fatal(err)
	}
	quoteRecord, _ = storage.QuotePublication(note.ID)
	if quoteRecord.Event.ID != quote.ID || !quoteRecord.Cancelled {
		t.Fatal("restored note received another quote")
	}

	if _, err := publisher.RemovePost(note.ID); err != nil {
		t.Fatal(err)
	}
	if len(storage.accountPublications) != 2 {
		t.Fatalf("repeated removal created %d publication records", len(storage.accountPublications))
	}
}

func TestRemovalWaitsForInflightQuoteBeforeQueuingDeletion(t *testing.T) {
	storage, publisher, note := accountPublicationFixture(t, "wss://one.example")
	quote, err := publisher.BuildQuote(note, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.CreditZapWithPublication(note.ID, 21, note, "zap", "hash", quote, publisher.Targets()); err != nil {
		t.Fatal(err)
	}

	publishing := make(chan struct{})
	release := make(chan struct{})
	publisher.publish = func(_ context.Context, _ string, _ *nostr.Event) error {
		close(publishing)
		<-release
		return nil
	}
	drained := make(chan struct{})
	go func() {
		publisher.publishPending(context.Background())
		close(drained)
	}()
	<-publishing

	removed := make(chan error, 1)
	go func() {
		_, err := publisher.RemovePost(note.ID)
		removed <- err
	}()
	select {
	case err := <-removed:
		t.Fatalf("removal completed while quote was in flight: %v", err)
	default:
	}
	if storage.accountPublications[deletionPublicationKey(quote.ID)] != nil {
		t.Fatal("deletion was queued before the in-flight quote completed")
	}

	close(release)
	<-drained
	if err := <-removed; err != nil {
		t.Fatal(err)
	}
	deletion := storage.accountPublications[deletionPublicationKey(quote.ID)]
	if deletion == nil || deletion.Event == nil {
		t.Fatal("deletion was not queued after the quote completed")
	}
}

func TestRemovalAndDeletionRollBackTogether(t *testing.T) {
	storage, publisher, note := accountPublicationFixture(t, "wss://one.example")
	quote, err := publisher.BuildQuote(note, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.CreditZapWithPublication(note.ID, 21, note, "zap", "hash", quote, publisher.Targets()); err != nil {
		t.Fatal(err)
	}
	path := storage.dataFile
	storage.dataFile = filepath.Join(t.TempDir(), "missing", "board.json")
	if _, err := publisher.RemovePost(note.ID); err == nil {
		t.Fatal("expected removal save failure")
	}
	if _, ok := storage.GetPost(note.ID); !ok || storage.IsRemoved(note.ID) {
		t.Fatal("failed removal changed board state")
	}
	record, _ := storage.QuotePublication(note.ID)
	if record.Cancelled {
		t.Fatal("failed removal cancelled quote")
	}
	if len(storage.accountPublications) != 1 {
		t.Fatal("failed removal left deletion record")
	}
	storage.dataFile = path
}

func TestLegacyPostIsNeverBackfilled(t *testing.T) {
	storage, publisher, note := accountPublicationFixture(t, "wss://one.example")
	if err := storage.AddPayment(note.ID, 1, note); err != nil {
		t.Fatal(err)
	}
	quote, err := publisher.BuildQuote(note, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.CreditZapWithPublication(note.ID, 5, note, "zap-one", "hash-one", quote, publisher.Targets()); err != nil {
		t.Fatal(err)
	}
	if _, ok := storage.QuotePublication(note.ID); ok {
		t.Fatal("existing post was backfilled on boost")
	}
	if _, err := storage.RemovePost(note.ID); err != nil {
		t.Fatal(err)
	}
	if err := storage.RestorePost(note.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.CreditZapWithPublication(note.ID, 5, note, "zap-two", "hash-two", quote, publisher.Targets()); err != nil {
		t.Fatal(err)
	}
	record, ok := storage.QuotePublication(note.ID)
	if !ok || !record.Suppressed || record.Event != nil {
		t.Fatalf("legacy tombstone=%+v", record)
	}
}
