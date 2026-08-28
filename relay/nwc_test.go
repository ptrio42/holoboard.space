package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fiatjaf/khatru"
	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip04"
	"github.com/nbd-wtf/go-nostr/nip44"
)

// These tests drive the real NWCBackend against a real khatru relay running in
// process, with a stand-in wallet on the other side. Nothing here is mocked at
// the protocol level: events get signed, encrypted, published and matched the
// same way they would against a live wallet.

// testStore is the smallest event store khatru needs to hold onto the wallet's
// info event. Requests and responses are ephemeral and never reach it.
type testStore struct {
	mu     sync.Mutex
	events []*nostr.Event
}

func (s *testStore) store(ctx context.Context, evt *nostr.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, evt)
	return nil
}

func (s *testStore) query(ctx context.Context, filter nostr.Filter) (chan *nostr.Event, error) {
	s.mu.Lock()
	var matched []*nostr.Event
	for _, evt := range s.events {
		if filter.Matches(evt) {
			matched = append(matched, evt)
		}
	}
	s.mu.Unlock()

	ch := make(chan *nostr.Event)
	go func() {
		defer close(ch)
		for _, evt := range matched {
			ch <- evt
		}
	}()
	return ch, nil
}

// startTestRelay brings up an in-process relay and returns its ws:// URL.
func startTestRelay(t *testing.T) string {
	t.Helper()

	if raceDetectorEnabled {
		t.Skip("skipping: khatru v0.7.6 races on its own listener list, see raceflag_norace_test.go")
	}

	rl := khatru.NewRelay()
	store := &testStore{}
	rl.StoreEvent = append(rl.StoreEvent, store.store)
	rl.QueryEvents = append(rl.QueryEvents, store.query)

	srv := httptest.NewServer(rl)
	t.Cleanup(srv.Close)

	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

// walletReply is what a stand-in wallet answers with for one command.
type walletReply struct {
	result any
	err    *nwcError
}

// fakeWallet plays the wallet service half of NIP-47.
type fakeWallet struct {
	t          *testing.T
	seckey     string
	pubkey     string
	relayURL   string
	encryption string

	// notifications advertised in the info event, space separated
	notifications string

	handler func(method string, params map[string]any) walletReply

	relay *nostr.Relay
}

func newFakeWallet(t *testing.T, relayURL, encryption, notifications string,
	handler func(string, map[string]any) walletReply) *fakeWallet {
	t.Helper()

	seckey := nostr.GeneratePrivateKey()
	pubkey, err := nostr.GetPublicKey(seckey)
	if err != nil {
		t.Fatalf("failed to derive wallet pubkey: %v", err)
	}

	return &fakeWallet{
		t:             t,
		seckey:        seckey,
		pubkey:        pubkey,
		relayURL:      relayURL,
		encryption:    encryption,
		notifications: notifications,
		handler:       handler,
	}
}

// connectionURI is what a user would paste into the relay's configuration.
func (w *fakeWallet) connectionURI(clientSecret string) string {
	return fmt.Sprintf("nostr+walletconnect://%s?relay=%s&secret=%s&lud16=%s",
		w.pubkey, url.QueryEscape(w.relayURL), clientSecret, url.QueryEscape("board@example.com"))
}

func (w *fakeWallet) sealFor(clientPubkey, plaintext string) string {
	w.t.Helper()

	if w.encryption == encNIP44 {
		key, err := nip44.GenerateConversationKey(clientPubkey, w.seckey)
		if err != nil {
			w.t.Fatalf("wallet failed to derive nip44 key: %v", err)
		}
		sealed, err := nip44Encrypt(plaintext, key)
		if err != nil {
			w.t.Fatalf("wallet failed to nip44 encrypt: %v", err)
		}
		return sealed
	}

	key, err := nip04.ComputeSharedSecret(clientPubkey, w.seckey)
	if err != nil {
		w.t.Fatalf("wallet failed to derive nip04 secret: %v", err)
	}
	sealed, err := nip04.Encrypt(plaintext, key)
	if err != nil {
		w.t.Fatalf("wallet failed to nip04 encrypt: %v", err)
	}
	return sealed
}

func (w *fakeWallet) open(clientPubkey, ciphertext string) (string, error) {
	if w.encryption == encNIP44 {
		key, err := nip44.GenerateConversationKey(clientPubkey, w.seckey)
		if err != nil {
			return "", err
		}
		return nip44.Decrypt(ciphertext, key)
	}

	key, err := nip04.ComputeSharedSecret(clientPubkey, w.seckey)
	if err != nil {
		return "", err
	}
	return nip04.Decrypt(ciphertext, key)
}

func (w *fakeWallet) sign(evt *nostr.Event) {
	w.t.Helper()
	if err := evt.Sign(w.seckey); err != nil {
		w.t.Fatalf("wallet failed to sign event: %v", err)
	}
}

// start publishes the info event and begins answering requests. It returns once
// the wallet is actually listening, so callers can issue a command right after.
func (w *fakeWallet) start(ctx context.Context) {
	w.t.Helper()

	relay, err := nostr.RelayConnect(ctx, w.relayURL)
	if err != nil {
		w.t.Fatalf("wallet failed to connect to relay: %v", err)
	}
	w.relay = relay
	w.t.Cleanup(func() { relay.Close() })

	info := nostr.Event{
		CreatedAt: nostr.Now(),
		Kind:      nwcKindInfo,
		Content:   "make_invoice lookup_invoice get_info",
		Tags:      nostr.Tags{{"encryption", w.encryption}},
	}
	if w.notifications != "" {
		info.Tags = append(info.Tags, nostr.Tag{"notifications", w.notifications})
	}
	w.sign(&info)
	if err := relay.Publish(ctx, info); err != nil {
		w.t.Fatalf("wallet failed to publish info event: %v", err)
	}

	sub, err := relay.Subscribe(ctx, nostr.Filters{{
		Kinds: []int{nwcKindRequest},
		Tags:  nostr.TagMap{"p": []string{w.pubkey}},
	}})
	if err != nil {
		w.t.Fatalf("wallet failed to subscribe for requests: %v", err)
	}

	// Wait for the relay to finish replaying stored events, so the
	// subscription is definitely live before the test sends anything.
	select {
	case <-sub.EndOfStoredEvents:
	case <-ctx.Done():
		w.t.Fatal("wallet subscription never reached EOSE")
	}

	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case evt, ok := <-sub.Events:
				if !ok {
					return
				}
				w.answer(ctx, evt)
			}
		}
	}()
}

func (w *fakeWallet) answer(ctx context.Context, req *nostr.Event) {
	plaintext, err := w.open(req.PubKey, req.Content)
	if err != nil {
		w.t.Errorf("wallet failed to decrypt request: %v", err)
		return
	}

	var parsed struct {
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
	}
	if err := json.Unmarshal([]byte(plaintext), &parsed); err != nil {
		w.t.Errorf("wallet failed to parse request: %v", err)
		return
	}

	reply := w.handler(parsed.Method, parsed.Params)

	envelope := map[string]any{"result_type": parsed.Method}
	if reply.err != nil {
		envelope["error"] = reply.err
	} else {
		envelope["result"] = reply.result
	}

	body, err := json.Marshal(envelope)
	if err != nil {
		w.t.Errorf("wallet failed to marshal response: %v", err)
		return
	}

	resp := nostr.Event{
		CreatedAt: nostr.Now(),
		Kind:      nwcKindResponse,
		Tags:      nostr.Tags{{"p", req.PubKey}, {"e", req.ID}},
		Content:   w.sealFor(req.PubKey, string(body)),
	}
	if w.encryption == encNIP44 {
		resp.Tags = append(resp.Tags, nostr.Tag{"encryption", encNIP44})
	}
	w.sign(&resp)

	if err := w.relay.Publish(ctx, resp); err != nil {
		w.t.Errorf("wallet failed to publish response: %v", err)
	}
}

// notifyPaid pushes a payment_received notification at the client.
func (w *fakeWallet) notifyPaid(ctx context.Context, clientPubkey string, tx nwcTransaction) {
	w.t.Helper()

	body, err := json.Marshal(map[string]any{
		"notification_type": "payment_received",
		"notification":      tx,
	})
	if err != nil {
		w.t.Fatalf("wallet failed to marshal notification: %v", err)
	}

	kind := nwcKindNotificationNIP04
	if w.encryption == encNIP44 {
		kind = nwcKindNotificationNIP44
	}

	evt := nostr.Event{
		CreatedAt: nostr.Now(),
		Kind:      kind,
		Tags:      nostr.Tags{{"p", clientPubkey}},
		Content:   w.sealFor(clientPubkey, string(body)),
	}
	w.sign(&evt)

	if err := w.relay.Publish(ctx, evt); err != nil {
		w.t.Fatalf("wallet failed to publish notification: %v", err)
	}
}

// newConnectedBackend wires a backend to a started wallet and loads its info.
func newConnectedBackend(t *testing.T, ctx context.Context, w *fakeWallet) *NWCBackend {
	t.Helper()

	clientSecret := nostr.GeneratePrivateKey()
	backend, err := ParseNWCURI(w.connectionURI(clientSecret))
	if err != nil {
		t.Fatalf("failed to parse connection URI: %v", err)
	}

	w.start(ctx)

	if err := backend.LoadInfo(ctx); err != nil {
		t.Fatalf("failed to load wallet info: %v", err)
	}
	return backend
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestParseNWCURI(t *testing.T) {
	secret := nostr.GeneratePrivateKey()
	pubkey, err := nostr.GetPublicKey(secret)
	if err != nil {
		t.Fatalf("failed to derive pubkey: %v", err)
	}

	t.Run("full URI", func(t *testing.T) {
		uri := fmt.Sprintf("nostr+walletconnect://%s?relay=%s&secret=%s&lud16=board%%40example.com",
			pubkey, url.QueryEscape("wss://relay.example.com"), secret)

		backend, err := ParseNWCURI(uri)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if backend.walletPubkey != pubkey {
			t.Errorf("wallet pubkey = %q, want %q", backend.walletPubkey, pubkey)
		}
		if backend.relayURL != "wss://relay.example.com" {
			t.Errorf("relay URL = %q", backend.relayURL)
		}
		if backend.LightningAddress() != "board@example.com" {
			t.Errorf("lud16 = %q", backend.LightningAddress())
		}
		// NIP-47: no info event yet, so NIP-04 until told otherwise.
		if backend.encryptionScheme() != encNIP04 {
			t.Errorf("default encryption = %q, want %q", backend.encryptionScheme(), encNIP04)
		}
	})

	t.Run("opaque form", func(t *testing.T) {
		uri := fmt.Sprintf("nostr+walletconnect:%s?relay=%s&secret=%s",
			pubkey, url.QueryEscape("wss://relay.example.com"), secret)
		if _, err := ParseNWCURI(uri); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	rejects := map[string]string{
		"empty":            "",
		"wrong scheme":     fmt.Sprintf("https://%s?relay=wss://r&secret=%s", pubkey, secret),
		"short pubkey":     fmt.Sprintf("nostr+walletconnect://abc?relay=wss://r&secret=%s", secret),
		"no relay":         fmt.Sprintf("nostr+walletconnect://%s?secret=%s", pubkey, secret),
		"non-hex secret":   fmt.Sprintf("nostr+walletconnect://%s?relay=wss://r&secret=%s", pubkey, strings.Repeat("z", 64)),
		"truncated secret": fmt.Sprintf("nostr+walletconnect://%s?relay=wss://r&secret=abcd", pubkey),
	}
	for name, uri := range rejects {
		t.Run("rejects "+name, func(t *testing.T) {
			if _, err := ParseNWCURI(uri); err == nil {
				t.Fatal("expected an error, got nil")
			}
		})
	}
}

func TestNWCGenerateInvoice(t *testing.T) {
	for _, encryption := range []string{encNIP04, encNIP44} {
		t.Run(encryption, func(t *testing.T) {
			ctx := testContext(t)
			relayURL := startTestRelay(t)

			var gotMethod string
			var gotAmount float64
			wallet := newFakeWallet(t, relayURL, encryption, "", func(method string, params map[string]any) walletReply {
				gotMethod = method
				gotAmount, _ = params["amount"].(float64)
				return walletReply{result: nwcTransaction{
					Type:        "incoming",
					State:       "pending",
					Invoice:     "lnbc10u1pexample",
					PaymentHash: "9f1c0d2b3a4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8",
					Amount:      1000 * 1000,
					CreatedAt:   time.Now().Unix(),
					ExpiresAt:   time.Now().Add(30 * time.Minute).Unix(),
				}}
			})

			backend := newConnectedBackend(t, ctx, wallet)

			if backend.encryptionScheme() != encryption {
				t.Fatalf("negotiated encryption = %q, want %q", backend.encryptionScheme(), encryption)
			}

			invoice, err := backend.GenerateInvoice(ctx, 1000, "Promote a note")
			if err != nil {
				t.Fatalf("GenerateInvoice failed: %v", err)
			}

			if gotMethod != "make_invoice" {
				t.Errorf("wallet saw method %q, want make_invoice", gotMethod)
			}
			// NIP-47 amounts are millisats, so 1000 sats has to go out as 1000000.
			if gotAmount != 1_000_000 {
				t.Errorf("wallet saw amount %v msat, want 1000000", gotAmount)
			}
			if invoice.PaymentRequest != "lnbc10u1pexample" {
				t.Errorf("payment request = %q", invoice.PaymentRequest)
			}
			if invoice.AmountSats != 1000 {
				t.Errorf("amount = %d sats, want 1000", invoice.AmountSats)
			}
			if invoice.ExpiresAt.IsZero() || !invoice.ExpiresAt.After(time.Now()) {
				t.Errorf("expiry = %v, want a time in the future", invoice.ExpiresAt)
			}
		})
	}
}

// TestNWCGenerateInvoiceDefaultsExpiry pins the guard against a zero expiry.
// CleanupExpiredInvoices reads a zero time as long overdue, so a wallet that
// omits expires_at would otherwise get its invoice deleted within the hour.
func TestNWCGenerateInvoiceDefaultsExpiry(t *testing.T) {
	ctx := testContext(t)
	relayURL := startTestRelay(t)

	wallet := newFakeWallet(t, relayURL, encNIP04, "", func(string, map[string]any) walletReply {
		return walletReply{result: nwcTransaction{
			Invoice:     "lnbc10u1pexample",
			PaymentHash: "abc123",
			Amount:      1000 * 1000,
			// no expires_at, no created_at
		}}
	})

	backend := newConnectedBackend(t, ctx, wallet)

	invoice, err := backend.GenerateInvoice(ctx, 1000, "no expiry")
	if err != nil {
		t.Fatalf("GenerateInvoice failed: %v", err)
	}
	if !invoice.ExpiresAt.After(time.Now().Add(50 * time.Minute)) {
		t.Errorf("expiry = %v, want roughly an hour out", invoice.ExpiresAt)
	}
}

func TestNWCCheckInvoice(t *testing.T) {
	settledAt := time.Now().Unix()

	cases := []struct {
		name       string
		tx         nwcTransaction
		wantPaid   bool
		wantAmount int64
	}{
		{
			name:       "settled_at set",
			tx:         nwcTransaction{PaymentHash: "aa", Amount: 2000 * 1000, SettledAt: settledAt},
			wantPaid:   true,
			wantAmount: 2000,
		},
		{
			name:       "state settled without settled_at",
			tx:         nwcTransaction{PaymentHash: "aa", Amount: 500 * 1000, State: "settled"},
			wantPaid:   true,
			wantAmount: 500,
		},
		{
			name:       "still pending",
			tx:         nwcTransaction{PaymentHash: "aa", Amount: 500 * 1000, State: "pending"},
			wantPaid:   false,
			wantAmount: 500,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ctx := testContext(t)
			relayURL := startTestRelay(t)

			var gotHash string
			wallet := newFakeWallet(t, relayURL, encNIP04, "", func(method string, params map[string]any) walletReply {
				if method != "lookup_invoice" {
					t.Errorf("wallet saw method %q, want lookup_invoice", method)
				}
				gotHash, _ = params["payment_hash"].(string)
				return walletReply{result: c.tx}
			})

			backend := newConnectedBackend(t, ctx, wallet)

			paid, amount, err := backend.CheckInvoice(ctx, "deadbeef")
			if err != nil {
				t.Fatalf("CheckInvoice failed: %v", err)
			}
			if gotHash != "deadbeef" {
				t.Errorf("wallet saw payment_hash %q", gotHash)
			}
			if paid != c.wantPaid {
				t.Errorf("paid = %v, want %v", paid, c.wantPaid)
			}
			if amount != c.wantAmount {
				t.Errorf("amount = %d sats, want %d", amount, c.wantAmount)
			}
		})
	}
}

// TestNWCWalletError checks that an error envelope surfaces as a Go error
// rather than being read as an empty success.
func TestNWCWalletError(t *testing.T) {
	ctx := testContext(t)
	relayURL := startTestRelay(t)

	wallet := newFakeWallet(t, relayURL, encNIP04, "", func(string, map[string]any) walletReply {
		return walletReply{err: &nwcError{Code: "NOT_FOUND", Message: "no such invoice"}}
	})

	backend := newConnectedBackend(t, ctx, wallet)

	_, _, err := backend.CheckInvoice(ctx, "deadbeef")
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if !strings.Contains(err.Error(), "NOT_FOUND") {
		t.Errorf("error = %q, want it to mention NOT_FOUND", err)
	}
}

func TestNWCWatchInvoices(t *testing.T) {
	for _, encryption := range []string{encNIP04, encNIP44} {
		t.Run(encryption, func(t *testing.T) {
			ctx := testContext(t)
			relayURL := startTestRelay(t)

			wallet := newFakeWallet(t, relayURL, encryption, "payment_received payment_sent",
				func(string, map[string]any) walletReply { return walletReply{result: nwcTransaction{}} })

			backend := newConnectedBackend(t, ctx, wallet)

			if !backend.SupportsNotifications() {
				t.Fatal("backend should have picked up payment_received from the info event")
			}

			paidCh, err := backend.WatchInvoices(ctx)
			if err != nil {
				t.Fatalf("WatchInvoices failed: %v", err)
			}

			settledAt := time.Now().Unix()

			// The watcher filters on Since, and it needs a moment to get its
			// subscription up. Keep pushing until one lands or we give up.
			deadline := time.After(10 * time.Second)
			ticker := time.NewTicker(200 * time.Millisecond)
			defer ticker.Stop()

			for {
				select {
				case <-deadline:
					t.Fatal("no payment_received notification reached the backend")

				case <-ticker.C:
					wallet.notifyPaid(ctx, backend.clientPubkey, nwcTransaction{
						Type:        "incoming",
						State:       "settled",
						Invoice:     "lnbc10u1pexample",
						PaymentHash: "9f1c0d2b3a4e5f60",
						Amount:      1234 * 1000,
						SettledAt:   settledAt,
					})

				case paid := <-paidCh:
					if paid.PaymentHash != "9f1c0d2b3a4e5f60" {
						t.Errorf("payment hash = %q", paid.PaymentHash)
					}
					if paid.AmountSats != 1234 {
						t.Errorf("amount = %d sats, want 1234", paid.AmountSats)
					}
					if !paid.PaidAt.Equal(time.Unix(settledAt, 0)) {
						t.Errorf("paid at = %v, want %v", paid.PaidAt, time.Unix(settledAt, 0))
					}
					return
				}
			}
		})
	}
}

// TestNWCWatchInvoicesWithoutNotificationSupport pins the fallback behaviour:
// a wallet that advertises nothing must not make the relay hang or spin. The
// channel simply stays quiet and closes with the context, and settlement is
// left to InvoiceManager.StartInvoiceReconciler.
func TestNWCWatchInvoicesWithoutNotificationSupport(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	relayURL := startTestRelay(t)

	wallet := newFakeWallet(t, relayURL, encNIP04, "",
		func(string, map[string]any) walletReply { return walletReply{result: nwcTransaction{}} })

	backend := newConnectedBackend(t, ctx, wallet)

	if backend.SupportsNotifications() {
		t.Fatal("wallet advertised no notifications, backend should say so")
	}

	paidCh, err := backend.WatchInvoices(ctx)
	if err != nil {
		t.Fatalf("WatchInvoices failed: %v", err)
	}

	select {
	case paid, ok := <-paidCh:
		if ok {
			t.Fatalf("expected no notifications, got %+v", paid)
		}
	case <-time.After(300 * time.Millisecond):
	}

	cancel()

	select {
	case _, ok := <-paidCh:
		if ok {
			t.Fatal("channel should be closed after the context is cancelled")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("channel was never closed after cancellation")
	}
}

// TestNWCBackendSatisfiesInterface is a compile-time check that the backend is
// actually usable where main.go plugs it in.
func TestNWCBackendSatisfiesInterface(t *testing.T) {
	var _ LightningBackend = (*NWCBackend)(nil)
}

// TestNWCCoinosPayloads pins the shapes a real wallet actually sends, captured
// from Coinos on 2026-08-28. The bolt11 strings are trimmed; nothing here
// asserts on their contents.
//
// Two details caught the implementation out and are worth keeping pinned.
// lookup_invoice carries no amount field at all while an invoice is pending,
// which is why CheckInvoice's amount is advisory and the reconciler credits the
// figure in storage instead. And settled_at arrives as JSON null, which has to
// unmarshal into the zero value rather than blowing up.
func TestNWCCoinosPayloads(t *testing.T) {
	t.Run("make_invoice", func(t *testing.T) {
		const payload = `{"type":"incoming","invoice":"lnbc210n1p4fz736sp586ps","description":"probe",` +
			`"amount":21000,"created_at":1787918906,"expires_at":1787919506,"fees_paid":0,` +
			`"payment_hash":"2e82b365c535bd602af8ce1fad86c8e70669c24e52d396be8e6e64cfac0e5591","metadata":{}}`

		var tx nwcTransaction
		if err := json.Unmarshal([]byte(payload), &tx); err != nil {
			t.Fatalf("failed to parse: %v", err)
		}
		if tx.Amount != 21000 {
			t.Errorf("amount = %d msat, want 21000", tx.Amount)
		}
		if tx.Amount/1000 != 21 {
			t.Errorf("amount = %d sats, want 21", tx.Amount/1000)
		}
		if tx.ExpiresAt != 1787919506 {
			t.Errorf("expires_at = %d", tx.ExpiresAt)
		}
		if tx.PaymentHash == "" || tx.Invoice == "" {
			t.Error("payment hash and invoice should both be set")
		}
		// No state field at all on this one, and it is certainly not paid.
		if tx.settled() {
			t.Error("a freshly minted invoice must not read as settled")
		}
	})

	t.Run("lookup_invoice pending", func(t *testing.T) {
		const payload = `{"type":"incoming","invoice":"lnbc210n1p4fz736sp586ps","description":"probe",` +
			`"payment_hash":"2e82b365c535bd602af8ce1fad86c8e70669c24e52d396be8e6e64cfac0e5591",` +
			`"fees_paid":0,"created_at":1787314706,"expires_at":1787919506,` +
			`"settled_at":null,"state":"pending","status":"pending"}`

		var tx nwcTransaction
		if err := json.Unmarshal([]byte(payload), &tx); err != nil {
			t.Fatalf("failed to parse: %v", err)
		}
		if tx.settled() {
			t.Error("a pending invoice must not read as settled")
		}
		if tx.SettledAt != 0 {
			t.Errorf("settled_at = %d, want 0 for JSON null", tx.SettledAt)
		}
		// The field is simply absent, so this is 0 and callers must not trust it.
		if tx.Amount != 0 {
			t.Errorf("amount = %d, want 0 since Coinos omits it while pending", tx.Amount)
		}
	})

	t.Run("settled by status alone", func(t *testing.T) {
		// Coinos fills state and status together, so a wallet that sends only
		// status still has to register as paid.
		const payload = `{"type":"incoming","payment_hash":"aa","amount":21000,"status":"settled"}`

		var tx nwcTransaction
		if err := json.Unmarshal([]byte(payload), &tx); err != nil {
			t.Fatalf("failed to parse: %v", err)
		}
		if !tx.settled() {
			t.Error("status settled must count as paid")
		}
	})
}
