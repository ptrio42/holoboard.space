package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/ecdsa"
	"github.com/btcsuite/btcd/chaincfg/chainhash"
	"github.com/lightningnetwork/lnd/zpay32"
	"github.com/nbd-wtf/go-nostr/nip19"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

func TestAuthorReceiptUsesIssuedProviderAfterChangeAndRestart(t *testing.T) {
	a, note, provider := supportFixture(t)
	request := &nostr.Event{Kind: 9734, CreatedAt: nostr.Now(), Tags: nostr.Tags{{"p", note.PubKey}, {"e", note.ID}, {"amount", "21000"}, {"relays", "wss://relay.example"}}}
	if err := request.Sign(nostr.GeneratePrivateKey()); err != nil {
		t.Fatal(err)
	}
	handler := a.Handler()
	rec := supportPost(t, handler, "/api/support/invoice", map[string]any{"note": note.ID, "amount_sats": 21, "zap_request": request})
	if rec.Code != 200 {
		t.Fatalf("invoice: %s", rec.Body.String())
	}
	var invoice struct {
		Invoice string `json:"invoice"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &invoice); err != nil {
		t.Fatal(err)
	}
	description, _ := json.Marshal(request)
	receipt := &nostr.Event{Kind: 9735, CreatedAt: nostr.Now(), Tags: nostr.Tags{{"p", note.PubKey}, {"e", note.ID}, {"bolt11", invoice.Invoice}, {"description", string(description)}}}
	if err := receipt.Sign(provider); err != nil {
		t.Fatal(err)
	}
	verify := func() *httptest.ResponseRecorder {
		return supportPost(t, handler, "/api/support/verify", map[string]any{"note": note.ID, "invoice": invoice.Invoice, "receipt": receipt})
	}
	if rec := verify(); rec.Code != 200 {
		t.Fatalf("original receipt: %s", rec.Body.String())
	}
	changed := a.cache[note.PubKey]
	changed.NostrPubkey, _ = nostr.GetPublicKey(nostr.GeneratePrivateKey())
	a.cache[note.PubKey] = changed
	if rec := verify(); rec.Code != 200 {
		t.Fatalf("provider change rejected issued receipt: %s", rec.Body.String())
	}
	reloaded, err := NewStorage(a.storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	restored := NewAuthorSupport(reloaded, NewPostFetcher(nil))
	restored.profile = func(context.Context, string, []string) (*nostr.Event, error) {
		return nil, fmt.Errorf("profile unavailable after restart")
	}
	handler = restored.Handler()
	if rec := verify(); rec.Code != 200 {
		t.Fatalf("valid receipt stopped verifying after current provider changed: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if post, _ := reloaded.GetPost(note.ID); post.TotalSatsPaid != 1 {
		t.Fatal("author receipt added ranking credit")
	}
	for _, test := range []struct {
		name   string
		mutate func(*nostr.Event)
		note   string
	}{
		{"other note", func(*nostr.Event) {}, strings.Repeat("a", 64)},
		{"other recipient", func(e *nostr.Event) { e.Tags[0][1] = strings.Repeat("a", 64) }, note.ID},
		{"other provider", func(e *nostr.Event) {
			if err := e.Sign(nostr.GeneratePrivateKey()); err != nil {
				t.Fatal(err)
			}
		}, note.ID},
		{"other invoice", func(e *nostr.Event) { e.Tags[2][1] = "invalid" }, note.ID},
	} {
		t.Run(test.name, func(t *testing.T) {
			forged := cloneNostrEvent(receipt)
			test.mutate(forged)
			rejected := supportPost(t, handler, "/api/support/verify", map[string]any{"note": test.note, "invoice": invoice.Invoice, "receipt": forged})
			if rejected.Code != 400 {
				t.Fatalf("changed receipt accepted: %d %s", rejected.Code, rejected.Body.String())
			}
		})
	}

}

func TestAuthorReceiptRejectsReencodedInvoiceWithSamePaymentHash(t *testing.T) {
	a, note, provider := supportFixture(t)
	request := &nostr.Event{Kind: 9734, CreatedAt: nostr.Now(), Tags: nostr.Tags{{"p", note.PubKey}, {"e", note.ID}, {"amount", "21000"}, {"relays", "wss://relay.example"}}}
	if err := request.Sign(nostr.GeneratePrivateKey()); err != nil {
		t.Fatal(err)
	}
	handler := a.Handler()
	response := supportPost(t, handler, "/api/support/invoice", map[string]any{"note": note.ID, "amount_sats": 21, "zap_request": request})
	var body struct {
		Invoice string `json:"invoice"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	description, _ := json.Marshal(request)
	receipt := &nostr.Event{Kind: 9735, CreatedAt: nostr.Now(), Tags: nostr.Tags{{"p", note.PubKey}, {"e", note.ID}, {"bolt11", body.Invoice}, {"description", string(description)}}}
	if err := receipt.Sign(provider); err != nil {
		t.Fatal(err)
	}
	invoice, err := decodeSupportInvoice(body.Invoice)
	if err != nil {
		t.Fatal(err)
	}
	invoice.Timestamp = invoice.Timestamp.Add(time.Second)
	node, _ := btcec.NewPrivateKey()
	invoice.Destination = node.PubKey()
	changed, err := invoice.Encode(zpay32.MessageSigner{SignCompact: func(message []byte) ([]byte, error) {
		return ecdsa.SignCompact(node, chainhash.HashB(message), true), nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	if changed == body.Invoice {
		t.Fatal("fixture did not change the invoice")
	}
	verified := supportPost(t, handler, "/api/support/verify", map[string]any{"note": note.ID, "invoice": changed, "receipt": receipt})
	if verified.Code != 400 {
		t.Fatalf("reencoded invoice accepted: %s", verified.Body.String())
	}
}

func TestFirstSettlementStoresActualQuoteSplitAfterAddressRemoval(t *testing.T) {
	s, publisher, note := accountPublicationFixture(t)
	key := nostr.GeneratePrivateKey()
	if err := note.Sign(key); err != nil {
		t.Fatal(err)
	}
	share := 30
	invoice := &PendingInvoice{PostID: note.ID, PaymentHash: "prepared-before-removal", AmountSats: 210, Event: note, AuthorShare: &share}
	if err := s.AddPendingInvoice(invoice); err != nil {
		t.Fatal(err)
	}
	profile := &nostr.Event{Kind: 0, CreatedAt: nostr.Now(), Tags: nostr.Tags{}, Content: `{}`}
	if err := profile.Sign(key); err != nil {
		t.Fatal(err)
	}
	publisher.profile = func(_ context.Context, pubkey string, _ []string) (*nostr.Event, string) {
		if pubkey == note.PubKey {
			return profile, "wss://profile.example"
		}
		return nil, ""
	}
	quote, err := publisher.BuildQuoteWithSplit(note, "", share)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SettleInvoiceWithPublication(invoice.PaymentHash, note, quote, nil); err != nil {
		t.Fatal(err)
	}
	post, _ := s.GetPost(note.ID)
	if campaignAuthorShare(post) != 0 || post.TotalSatsPaid != 210 || *quoteAuthorShare(quote) != 0 {
		t.Fatal("first settlement did not bind its actual public quote split")
	}
	loaded, err := NewStorage(s.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.CampaignEntries(time.Now())[0].AuthorShare != 0 {
		t.Fatal("restart changed the actual public split")
	}
}

func TestAuthorSupportDiscoversProfileOutsideConfiguredRelays(t *testing.T) {
	previousDiscovery := discoveryRelays
	discoveryRelays = nil
	t.Cleanup(func() { discoveryRelays = previousDiscovery })
	configured, outside := startTestRelay(t), startTestRelay(t)
	key := nostr.GeneratePrivateKey()
	author, _ := nostr.GetPublicKey(key)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	for _, fixture := range []struct {
		relay   string
		kind    int
		tags    nostr.Tags
		content string
	}{
		{configured, kindRelayList, nostr.Tags{{"r", outside, "write"}}, ""},
		{outside, 0, nostr.Tags{}, `{"lud16":"author@wallet.example"}`},
	} {
		connection, err := nostr.RelayConnect(ctx, fixture.relay)
		if err != nil {
			t.Fatal(err)
		}
		event := nostr.Event{Kind: fixture.kind, CreatedAt: nostr.Now(), Tags: fixture.tags, Content: fixture.content}
		if err := event.Sign(key); err != nil {
			t.Fatal(err)
		}
		if err := connection.Publish(ctx, event); err != nil {
			t.Fatal(err)
		}
		connection.Close()
	}
	if relay := findPaymentProfileRelay(ctx, author, []string{configured}); relay != outside {
		t.Fatalf("quote profile discovery failed: %q", relay)
	}
	support := NewAuthorSupport(newTestStorage(t), NewPostFetcher([]string{configured}))
	if profile, err := support.profile(ctx, author, nil); err != nil || profile == nil {
		t.Fatalf("quote finds the profile but author support does not: %v", err)
	}
}

func TestAuthorInvoiceVerificationContextRollsBackOnSaveFailure(t *testing.T) {
	a, note, _ := supportFixture(t)
	a.storage.dataFile = filepath.Join(t.TempDir(), "missing", "board.json")
	response := supportPost(t, a.Handler(), "/api/support/invoice", map[string]any{"note": note.ID, "amount_sats": 21})
	if response.Code != 503 || len(a.storage.authorInvoices) != 0 {
		t.Fatalf("unsaved invoice was offered: %d %s", response.Code, response.Body.String())
	}
	post, _ := a.storage.GetPost(note.ID)
	if post.TotalSatsPaid != 1 {
		t.Fatal("failed author invoice changed ranking")
	}
}

func TestAuthorInvoiceContextRejectsPaymentHashRebinding(t *testing.T) {
	s := newTestStorage(t)
	record := AuthorInvoiceContext{NoteID: strings.Repeat("a", 64), Author: strings.Repeat("b", 64), NostrPubkey: strings.Repeat("c", 64), InvoiceDigest: strings.Repeat("d", 64)}
	if err := s.AddAuthorInvoice("hash", record); err != nil {
		t.Fatal(err)
	}
	if err := s.AddAuthorInvoice("hash", record); err != nil {
		t.Fatal(err)
	}
	changed := record
	changed.NoteID = strings.Repeat("e", 64)
	if err := s.AddAuthorInvoice("hash", changed); err == nil {
		t.Fatal("payment hash was rebound to another note")
	}
	loaded, err := NewStorage(s.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	if stored, ok := loaded.GetAuthorInvoice("hash"); !ok || stored != record {
		t.Fatal("original context did not survive restart")
	}
}

func TestNewCampaignOnlyDropsAuthorShareForConfirmedMissingAddress(t *testing.T) {
	for _, test := range []struct {
		name, metadata string
		unavailable    bool
		want           int
	}{
		{"no address", `{}`, false, 0},
		{"Lightning address", `{"lud16":"author@wallet.example"}`, false, 20},
		{"LNURL", `{"lud06":"lnurl1example"}`, false, 20},
		{"malformed profile", `{`, false, 20},
		{"null profile", `null`, false, 20},
		{"array profile", `[]`, false, 20},
		{"failed discovery", `{}`, true, 20},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, publisher, note := accountPublicationFixture(t)
			key := nostr.GeneratePrivateKey()
			if err := note.Sign(key); err != nil {
				t.Fatal(err)
			}
			profile := &nostr.Event{Kind: 0, CreatedAt: nostr.Now(), Tags: nostr.Tags{}, Content: test.metadata}
			if err := profile.Sign(key); err != nil {
				t.Fatal(err)
			}
			support := NewAuthorSupport(s, NewPostFetcher(nil))
			support.profile = func(context.Context, string, []string) (*nostr.Event, error) {
				if test.unavailable {
					return nil, fmt.Errorf("profile lookup failed")
				}
				return profile, nil
			}
			manager := NewInvoiceManager(NewMockLightningBackend(), s, nil, 1000)
			manager.authorSupport = support
			invoice, err := manager.GeneratePromotionInvoiceWithContact(context.Background(), note.ID, 210, nil, note.PubKey, nil, "", note)
			if err != nil {
				t.Fatal(err)
			}
			pending, ok := s.GetPendingInvoice(invoice.PaymentHash)
			if !ok || pending.AuthorShare == nil || *pending.AuthorShare != test.want || pending.AmountSats != 210 {
				t.Fatalf("incorrect invoice: %+v", pending)
			}
			publisher.profile = func(_ context.Context, pubkey string, _ []string) (*nostr.Event, string) {
				if test.unavailable || pubkey != note.PubKey {
					return nil, ""
				}
				return profile, "wss://profile.example"
			}
			quote, err := publisher.BuildQuoteWithSplit(note, "", 20)
			if err != nil {
				t.Fatal(err)
			}
			if *quoteAuthorShare(quote) != test.want {
				t.Fatalf("quote disagrees with invoice: %v", quote.Tags)
			}
			if _, err := s.SettleInvoiceWithPublication(invoice.PaymentHash, note, quote, nil); err != nil {
				t.Fatal(err)
			}
			post, _ := s.GetPost(note.ID)
			if campaignAuthorShare(post) != test.want || post.TotalSatsPaid != 210 {
				t.Fatal("campaign split or ranking disagrees with first settlement")
			}
			manager.authorSupport.profile = func(context.Context, string, []string) (*nostr.Event, error) {
				return nil, fmt.Errorf("now unavailable")
			}
			changed := 50
			boost, err := manager.GeneratePromotionInvoiceWithContact(context.Background(), note.ID, 21, nil, note.PubKey, nil, "", note, &changed)
			if err != nil {
				t.Fatal(err)
			}
			saved, _ := s.GetPendingInvoice(boost.PaymentHash)
			if *saved.AuthorShare != test.want {
				t.Fatal("boost replaced the first-settled split")
			}
		})
	}
}

func TestAuthorEndpointDistinguishesMissingAddressAndWalletOutage(t *testing.T) {
	a, note, _ := supportFixture(t)
	a.client.Transport = supportTransport(func(*http.Request) (*http.Response, error) { return nil, fmt.Errorf("wallet temporarily unavailable") })
	response := supportPost(t, a.Handler(), "/api/support", map[string]any{"note": note.ID})
	var body authorEndpoint
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if response.Code != 200 || body.Available || body.ReasonCode != "unavailable" {
		t.Fatalf("wallet outage treated as missing address: %s", response.Body.String())
	}
	key := nostr.GeneratePrivateKey()
	if err := note.Sign(key); err != nil {
		t.Fatal(err)
	}
	if err := a.storage.AddPayment(note.ID, 1, note); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ metadata, reason string }{
		{`{}`, "no_address"},
		{`null`, "unavailable"},
		{`[]`, "unavailable"},
		{`{`, "unavailable"},
	} {
		profile := &nostr.Event{Kind: 0, CreatedAt: nostr.Now(), Tags: nostr.Tags{}, Content: test.metadata}
		if err := profile.Sign(key); err != nil {
			t.Fatal(err)
		}
		a.profile = func(context.Context, string, []string) (*nostr.Event, error) { return profile, nil }
		response = supportPost(t, a.Handler(), "/api/support", map[string]any{"note": note.ID})
		body = authorEndpoint{}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if response.Code != 200 || body.Available || body.ReasonCode != test.reason {
			t.Fatalf("incorrect address availability for %s: %s", test.metadata, response.Body.String())
		}
	}
}

func TestNewPreviewUsesConfirmedAuthorAddressWithoutAddingPaymentState(t *testing.T) {
	previous := discoveryRelays
	discoveryRelays = nil
	t.Cleanup(func() { discoveryRelays = previous })
	relayURL := startTestRelay(t)
	s := newTestStorage(t)
	key := nostr.GeneratePrivateKey()
	note := &nostr.Event{Kind: 1, CreatedAt: nostr.Now(), Tags: nostr.Tags{}, Content: "An unpaid note"}
	if err := note.Sign(key); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	connection, err := nostr.RelayConnect(ctx, relayURL)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := connection.Publish(ctx, *note); err != nil {
		t.Fatal(err)
	}
	reference, err := nip19.EncodeEvent(note.ID, []string{relayURL}, note.PubKey)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, content string
		fail          bool
		want          int
	}{
		{"confirmed absence", `{}`, false, 0},
		{"working address", `{"lud16":"author@wallet.example"}`, false, 20},
		{"unavailable profile", `{}`, true, 20},
	} {
		t.Run(test.name, func(t *testing.T) {
			support := NewAuthorSupport(s, NewPostFetcher([]string{relayURL}))
			support.profile = func(context.Context, string, []string) (*nostr.Event, error) {
				if test.fail {
					return nil, fmt.Errorf("unavailable")
				}
				profile := &nostr.Event{Kind: 0, CreatedAt: nostr.Now(), Tags: nostr.Tags{}, Content: test.content}
				if err := profile.Sign(key); err != nil {
					t.Fatal(err)
				}
				return profile, nil
			}
			response := postPromote(t, PreviewHandler(s, support.fetcher, support), map[string]any{"note": reference}, "1.2.3.4")
			var body struct {
				AuthorShare int `json:"author_share"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if response.Code != 200 || body.AuthorShare != test.want {
				t.Fatalf("preview allocation: %s", response.Body.String())
			}
			if len(s.posts) != 0 || len(s.pendingInvoices) != 0 || len(s.authorInvoices) != 0 {
				t.Fatal("preview persisted payment state")
			}
		})
	}
}

func TestLegacyAuthorInvoiceReceiptUsesCurrentProviderWhenNoContextExists(t *testing.T) {
	a, note, provider := supportFixture(t)
	request := &nostr.Event{Kind: 9734, CreatedAt: nostr.Now(), Tags: nostr.Tags{{"p", note.PubKey}, {"e", note.ID}, {"amount", "21000"}, {"relays", "wss://relay.example"}}}
	if err := request.Sign(nostr.GeneratePrivateKey()); err != nil {
		t.Fatal(err)
	}
	handler := a.Handler()
	response := supportPost(t, handler, "/api/support/invoice", map[string]any{"note": note.ID, "amount_sats": 21, "zap_request": request})
	var body struct {
		Invoice string `json:"invoice"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	a.storage.authorInvoices = make(map[string]AuthorInvoiceContext)
	description, _ := json.Marshal(request)
	receipt := &nostr.Event{Kind: 9735, CreatedAt: nostr.Now(), Tags: nostr.Tags{{"p", note.PubKey}, {"e", note.ID}, {"bolt11", body.Invoice}, {"description", string(description)}}}
	if err := receipt.Sign(provider); err != nil {
		t.Fatal(err)
	}
	verified := supportPost(t, handler, "/api/support/verify", map[string]any{"note": note.ID, "invoice": body.Invoice, "receipt": receipt})
	if verified.Code != 200 {
		t.Fatalf("legacy receipt rejected: %s", verified.Body.String())
	}
}
