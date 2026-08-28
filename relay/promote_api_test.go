package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip19"
)

// promoteFixture wires the endpoint against a mock wallet and a board that
// already holds one note, so nothing here reaches the network. Notes the relay
// already knows are not fetched, which is the path these tests exercise.
func promoteFixture(t *testing.T) (http.HandlerFunc, *Storage, string) {
	t.Helper()

	storage := newTestStorage(t)
	postID := seedPromotedPost(t, storage, nostr.GeneratePrivateKey())

	monitor := NewPaymentMonitor(storage, "relay", NewPostFetcher(nil), NewLNURLResolver())
	invoices := NewInvoiceManager(NewMockLightningBackend(), storage, monitor, 1000)

	return PromoteHandler(storage, invoices, NewPostFetcher(nil)), storage, postID
}

func postPromote(t *testing.T, handler http.HandlerFunc, body any, addr string) *httptest.ResponseRecorder {
	t.Helper()

	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("failed to encode body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/promote", bytes.NewReader(encoded))
	req.Header.Set("Fly-Client-IP", addr)

	rec := httptest.NewRecorder()
	handler(rec, req)
	return rec
}

func TestPromoteMintsAnInvoice(t *testing.T) {
	handler, storage, postID := promoteFixture(t)

	rec := postPromote(t, handler, promoteRequest{Note: postID, AmountSats: 2100}, "1.1.1.1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
	}

	var out promoteResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("failed to decode: %v", err)
	}
	if out.AmountSats != 2100 {
		t.Errorf("amount = %d, want 2100", out.AmountSats)
	}
	if out.NoteID != postID {
		t.Errorf("note id = %s, want %s", short(out.NoteID, 8), short(postID, 8))
	}
	if out.Invoice == "" || out.PaymentHash == "" {
		t.Error("invoice and payment hash should both be set")
	}
	if out.ExpiresAt <= time.Now().Unix() {
		t.Error("expiry should be in the future")
	}

	// And it is now something the reconciler will ask the wallet about.
	if _, waiting := storage.GetPendingInvoice(out.PaymentHash); !waiting {
		t.Error("the minted invoice was not recorded as pending")
	}
}

func TestPromoteAcceptsBech32(t *testing.T) {
	handler, _, postID := promoteFixture(t)

	encoded, err := nip19.EncodeNote(postID)
	if err != nil {
		t.Fatalf("failed to encode note: %v", err)
	}

	rec := postPromote(t, handler, promoteRequest{Note: "nostr:" + encoded}, "2.2.2.2")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
	}

	var out promoteResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("failed to decode: %v", err)
	}
	if out.NoteID != postID {
		t.Errorf("note id = %s, want the hex form of what was sent", out.NoteID)
	}
	// No amount asked for, so the default applies.
	if out.AmountSats != 1000 {
		t.Errorf("amount = %d, want the 1000 default", out.AmountSats)
	}
}

func TestPromoteRejections(t *testing.T) {
	cases := []struct {
		name string
		body promoteRequest
		want int
	}{
		{"empty note", promoteRequest{Note: ""}, http.StatusBadRequest},
		{"not an id", promoteRequest{Note: "hello"}, http.StatusBadRequest},
		{"half an id", promoteRequest{Note: "abcdef"}, http.StatusBadRequest},
		{"negative amount", promoteRequest{Note: "", AmountSats: -1}, http.StatusBadRequest},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			handler, _, _ := promoteFixture(t)
			rec := postPromote(t, handler, c.body, "3.3.3.3")
			if rec.Code != c.want {
				t.Errorf("status %d, want %d, body %s", rec.Code, c.want, rec.Body.String())
			}
		})
	}
}

// An amount outside the bounds is refused even when the note is fine.
func TestPromoteAmountBounds(t *testing.T) {
	handler, _, postID := promoteFixture(t)

	for _, amount := range []int64{-5, promoteMaxSats + 1} {
		rec := postPromote(t, handler, promoteRequest{Note: postID, AmountSats: amount}, "4.4.4.4")
		if rec.Code != http.StatusBadRequest {
			t.Errorf("amount %d returned %d, want 400", amount, rec.Code)
		}
	}
}

func TestPromoteRejectsUnknownNote(t *testing.T) {
	handler, _, _ := promoteFixture(t)

	// A well formed id the board does not hold. The fetcher has no relays, so
	// the lookup fails immediately rather than reaching the network.
	unknown := "1111111111111111111111111111111111111111111111111111111111111111"
	rec := postPromote(t, handler, promoteRequest{Note: unknown}, "5.5.5.5")
	if rec.Code != http.StatusNotFound {
		t.Errorf("status %d, want 404, body %s", rec.Code, rec.Body.String())
	}
}

func TestPromoteRejectsWrongMethod(t *testing.T) {
	handler, _, _ := promoteFixture(t)

	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		req := httptest.NewRequest(method, "/api/promote", nil)
		rec := httptest.NewRecorder()
		handler(rec, req)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s returned %d, want 405", method, rec.Code)
		}
	}
}

// The rate limit is the guard against somebody looping the endpoint and
// filling the wallet with invoices nobody will pay.
func TestPromoteRateLimit(t *testing.T) {
	handler, _, postID := promoteFixture(t)

	for i := 0; i < promoteBurst; i++ {
		rec := postPromote(t, handler, promoteRequest{Note: postID}, "6.6.6.6")
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d returned %d, expected the burst to be allowed", i+1, rec.Code)
		}
	}

	rec := postPromote(t, handler, promoteRequest{Note: postID}, "6.6.6.6")
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("request past the burst returned %d, want 429", rec.Code)
	}

	// A different caller is unaffected.
	other := postPromote(t, handler, promoteRequest{Note: postID}, "7.7.7.7")
	if other.Code != http.StatusOK {
		t.Errorf("a different address returned %d, want 200", other.Code)
	}
}

func TestRateLimiterWindowExpires(t *testing.T) {
	limiter := newRateLimiter(2, time.Minute)
	base := time.Unix(1_800_000_000, 0)

	if !limiter.allow("a", base) || !limiter.allow("a", base) {
		t.Fatal("the burst should be allowed")
	}
	if limiter.allow("a", base) {
		t.Fatal("a third request inside the window should be refused")
	}
	if !limiter.allow("a", base.Add(2*time.Minute)) {
		t.Error("the window should have expired")
	}
}

func TestPromoteStatus(t *testing.T) {
	handler, storage, postID := promoteFixture(t)

	rec := postPromote(t, handler, promoteRequest{Note: postID, AmountSats: 500}, "8.8.8.8")
	var out promoteResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("failed to decode: %v", err)
	}

	status := PromoteStatusHandler(storage)
	ask := func() promoteStatus {
		req := httptest.NewRequest(http.MethodGet,
			fmt.Sprintf("/api/promote/status?payment_hash=%s&note=%s", out.PaymentHash, postID), nil)
		rr := httptest.NewRecorder()
		status(rr, req)
		var s promoteStatus
		if err := json.Unmarshal(rr.Body.Bytes(), &s); err != nil {
			t.Fatalf("failed to decode status: %v", err)
		}
		return s
	}

	before := ask()
	if !before.Pending {
		t.Error("a freshly minted invoice should read as pending")
	}
	if before.SatsPaid != 1 {
		t.Errorf("sats = %d, want the seeded 1", before.SatsPaid)
	}

	// Settle it the way the reconciler would.
	monitor := NewPaymentMonitor(storage, "relay", NewPostFetcher(nil), NewLNURLResolver())
	if err := monitor.ProcessInvoicePayment(out.PaymentHash, out.AmountSats); err != nil {
		t.Fatalf("failed to settle: %v", err)
	}

	after := ask()
	if after.Pending {
		t.Error("a settled invoice should no longer read as pending")
	}
	// The endpoint never claims "settled"; the caller tells it apart from an
	// expiry by the sats having moved.
	if after.SatsPaid != 501 {
		t.Errorf("sats = %d, want 501", after.SatsPaid)
	}
}

func TestPromoteStatusNeedsAHash(t *testing.T) {
	_, storage, _ := promoteFixture(t)

	req := httptest.NewRequest(http.MethodGet, "/api/promote/status", nil)
	rec := httptest.NewRecorder()
	PromoteStatusHandler(storage)(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status %d, want 400", rec.Code)
	}
}
