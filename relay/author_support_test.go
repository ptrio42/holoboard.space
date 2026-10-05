package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/ecdsa"
	"github.com/btcsuite/btcd/chaincfg"
	"github.com/btcsuite/btcd/chaincfg/chainhash"
	"github.com/lightningnetwork/lnd/zpay32"
	"github.com/nbd-wtf/go-nostr"
)

type supportTransport func(*http.Request) (*http.Response, error)

func (f supportTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func supportFixture(t *testing.T) (*AuthorSupport, *nostr.Event, string) {
	t.Helper()
	s := newTestStorage(t)
	key := nostr.GeneratePrivateKey()
	note := &nostr.Event{Kind: 1, CreatedAt: nostr.Now(), Tags: nostr.Tags{}, Content: "A campaign"}
	if err := note.Sign(key); err != nil {
		t.Fatal(err)
	}
	if err := s.AddPayment(note.ID, 1, note); err != nil {
		t.Fatal(err)
	}
	profile := &nostr.Event{Kind: 0, CreatedAt: nostr.Now(), Tags: nostr.Tags{}, Content: `{"lud16":"author@wallet.example"}`}
	if err := profile.Sign(key); err != nil {
		t.Fatal(err)
	}
	providerKey := nostr.GeneratePrivateKey()
	providerPubkey, _ := nostr.GetPublicKey(providerKey)
	a := NewAuthorSupport(s, NewPostFetcher(nil))
	a.profile = func(context.Context, string, []string) (*nostr.Event, error) { return profile, nil }
	a.client.Transport = supportTransport(func(r *http.Request) (*http.Response, error) {
		var body any
		if strings.HasPrefix(r.URL.Path, "/.well-known/") {
			body = map[string]any{"tag": "payRequest", "callback": "https://wallet.example/pay", "metadata": `[["text/plain","Support"]]`, "minSendable": 1000, "maxSendable": 100000000, "allowsNostr": true, "nostrPubkey": providerPubkey}
		} else {
			amount, _ := strconv.ParseInt(r.URL.Query().Get("amount"), 10, 64)
			description := `[["text/plain","Support"]]`
			if zap := r.URL.Query().Get("nostr"); zap != "" {
				description = zap
			}
			body = map[string]any{"pr": mintInvoice(t, amount, description, &chaincfg.MainNetParams)}
		}
		encoded, _ := json.Marshal(body)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(encoded)), Header: make(http.Header)}, nil
	})
	return a, note, providerKey
}

func supportPost(t *testing.T, handler http.HandlerFunc, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest("POST", path, bytes.NewReader(encoded)))
	return rec
}

func TestAuthorInvoiceGoesDirectlyToAuthorAndNeverAddsWeight(t *testing.T) {
	a, note, provider := supportFixture(t)
	handler := a.Handler()
	for _, native := range []bool{false, true} {
		body := map[string]any{"note": note.ID, "amount_sats": 21}
		if native {
			var zap nostr.Event
			if err := json.Unmarshal([]byte(zapRequestJSON(t, nostr.GeneratePrivateKey(), nostr.Tags{{"p", note.PubKey}, {"e", note.ID}, {"amount", "21000"}, {"relays", "wss://relay.example"}}, "")), &zap); err != nil {
				t.Fatal(err)
			}
			body["zap_request"] = zap
		}
		rec := supportPost(t, handler, "/api/support/invoice", body)
		if rec.Code != 200 {
			t.Fatalf("invoice status %d: %s", rec.Code, rec.Body.String())
		}
		var result struct {
			Invoice string `json:"invoice"`
			Author  string `json:"author"`
		}
		json.Unmarshal(rec.Body.Bytes(), &result)
		if result.Author != note.PubKey {
			t.Fatal("wrong payment recipient")
		}
		if native {
			description, _ := json.Marshal(body["zap_request"])
			receipt := &nostr.Event{Kind: 9735, CreatedAt: nostr.Now(), Tags: nostr.Tags{{"p", note.PubKey}, {"e", note.ID}, {"bolt11", result.Invoice}, {"description", string(description)}}}
			if err := receipt.Sign(provider); err != nil {
				t.Fatal(err)
			}
			verified := supportPost(t, handler, "/api/support/verify", map[string]any{"note": note.ID, "invoice": result.Invoice, "receipt": receipt})
			if verified.Code != 200 {
				t.Fatalf("receipt rejected: %s", verified.Body.String())
			}
			receipt.Sig = strings.Repeat("0", 128)
			forged := supportPost(t, handler, "/api/support/verify", map[string]any{"note": note.ID, "invoice": result.Invoice, "receipt": receipt})
			if forged.Code == 200 {
				t.Fatal("forged receipt accepted")
			}
		}
	}
	post, _ := a.storage.GetPost(note.ID)
	if post.TotalSatsPaid != 1 || len(post.Payments) != 1 {
		t.Fatal("author tip changed ranking")
	}
}

func TestAuthorInvoiceRejectsWrongAmountsRecipientsAndPrivateEndpoints(t *testing.T) {
	a, note, _ := supportFixture(t)
	for _, amount := range []int64{0, -1, 100001} {
		rec := supportPost(t, a.Handler(), "/api/support/invoice", map[string]any{"note": note.ID, "amount_sats": amount})
		if rec.Code != 400 {
			t.Fatalf("invalid amount %d accepted: %d", amount, rec.Code)
		}
	}
	for _, endpoint := range []string{"http://wallet.example", "https://127.0.0.1", "https://169.254.169.254", "https://100.64.0.1", "https://[::1]", "https://localhost", "https://user:password@wallet.example", "https://wallet.example:8080"} {
		if _, err := publicPaymentURL(endpoint); err == nil {
			t.Errorf("accepted %s", endpoint)
		}
	}
	if _, err := publicPaymentURL("https://wallet.example/pay"); err != nil {
		t.Fatal(err)
	}
	a.client.Transport = supportTransport(func(_ *http.Request) (*http.Response, error) {
		body := `{"pr":"` + mintInvoice(t, 22000, `[["text/plain","Support"]]`, &chaincfg.MainNetParams) + `"}`
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	rec := supportPost(t, a.Handler(), "/api/support/invoice", map[string]any{"note": note.ID, "amount_sats": 21})
	if rec.Code != 502 {
		t.Fatalf("wrong invoice amount status = %d", rec.Code)
	}
}

func TestNativeAuthorRequestRejectsChangedRecipientNoteAndAmount(t *testing.T) {
	a, note, _ := supportFixture(t)
	for _, tags := range []nostr.Tags{
		{{"p", strings.Repeat("a", 64)}, {"e", note.ID}, {"amount", "21000"}},
		{{"p", note.PubKey}, {"e", strings.Repeat("a", 64)}, {"amount", "21000"}},
		{{"p", note.PubKey}, {"e", note.ID}, {"amount", "22000"}},
		{{"p", note.PubKey}, {"p", note.PubKey}, {"e", note.ID}, {"amount", "21000"}},
	} {
		request := &nostr.Event{Kind: 9734, CreatedAt: nostr.Now(), Tags: tags}
		if err := request.Sign(nostr.GeneratePrivateKey()); err != nil {
			t.Fatal(err)
		}
		rec := supportPost(t, a.Handler(), "/api/support/invoice", map[string]any{"note": note.ID, "amount_sats": 21, "zap_request": request})
		if rec.Code != 400 {
			t.Fatalf("changed author request accepted: %s", rec.Body.String())
		}
	}
}

func TestWalletPreimageMustMatchAuthorInvoice(t *testing.T) {
	a, _, _ := supportFixture(t)
	proof := sha256.Sum256([]byte("test-only wallet proof"))
	bolt11 := mintInvoice(t, 21000, "author support", &chaincfg.MainNetParams)
	invoice, err := decodeSupportInvoice(bolt11)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(proof[:])
	invoice.PaymentHash = &hash
	node, _ := btcec.NewPrivateKey()
	invoice.Destination = node.PubKey()
	bolt11, err = invoice.Encode(zpay32.MessageSigner{SignCompact: func(msg []byte) ([]byte, error) { return ecdsa.SignCompact(node, chainhash.HashB(msg), true), nil }})
	if err != nil {
		t.Fatal(err)
	}
	handler := a.Handler()
	rec := supportPost(t, handler, "/api/support/verify", map[string]any{"invoice": bolt11, "preimage": hex.EncodeToString(proof[:])})
	if rec.Code != 200 {
		t.Fatalf("valid proof rejected: %s", rec.Body.String())
	}
	rec = supportPost(t, handler, "/api/support/verify", map[string]any{"invoice": bolt11, "preimage": strings.Repeat("0", 64)})
	if rec.Code != 400 {
		t.Fatal("wrong preimage accepted")
	}
}

func TestZapOnStoredPaidPromotionBoostsOriginalOnce(t *testing.T) {
	s, publisher, note := accountPublicationFixture(t)
	quote, err := publisher.BuildQuoteWithSplit(note, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreditZapWithPublication(note.ID, 1, note, "initial", "initial-hash", quote, nil); err != nil {
		t.Fatal(err)
	}
	provider := nostr.GeneratePrivateKey()
	pubkey, _ := nostr.GetPublicKey(provider)
	receipt := mintZapReceipt(t, provider, 21000, nostr.Tags{{"p", publisher.relayPubkey}, {"e", quote.ID}, {"amount", "21000"}})
	receipt.Tags[0][1] = publisher.relayPubkey
	receipt.Sign(provider)
	monitor := NewPaymentMonitor(s, publisher.relayPubkey, NewPostFetcher(nil), seedResolver(pubkey))
	for i := 0; i < 2; i++ {
		if err := monitor.ProcessZap(context.Background(), receipt); err != nil {
			t.Fatal(err)
		}
	}
	post, _ := s.GetPost(note.ID)
	if post.TotalSatsPaid != 22 {
		t.Fatalf("total = %d, want 22", post.TotalSatsPaid)
	}
	if s.HasPost(quote.ID) {
		t.Fatal("bot quote was promoted instead of original")
	}
}
