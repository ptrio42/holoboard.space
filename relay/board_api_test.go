package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// seedPaidNote stores a note with a given sats total and last payment time.
// AddPayment stamps LastPaymentTimestamp with time.Now(), so the field is
// overwritten afterwards to make the ordering deterministic.
func seedPaidNote(t *testing.T, storage *Storage, content string, sats int64, paidAt time.Time) string {
	t.Helper()

	evt := &nostr.Event{
		CreatedAt: nostr.Timestamp(paidAt.Unix()),
		Kind:      1,
		Tags:      nostr.Tags{},
		Content:   content,
	}
	if err := evt.Sign(nostr.GeneratePrivateKey()); err != nil {
		t.Fatalf("failed to sign note: %v", err)
	}
	if err := storage.AddPayment(evt.ID, sats, evt); err != nil {
		t.Fatalf("failed to store note: %v", err)
	}

	storage.mu.Lock()
	storage.posts[evt.ID].LastPaymentTimestamp = paidAt
	storage.mu.Unlock()

	return evt.ID
}

func fetchLedger(t *testing.T, storage *Storage, method string) (*http.Response, boardResponse) {
	t.Helper()

	req := httptest.NewRequest(method, "/api/board", nil)
	rec := httptest.NewRecorder()
	BoardHandler(storage)(rec, req)

	res := rec.Result()
	var body boardResponse
	if res.StatusCode == http.StatusOK && method != http.MethodHead {
		if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode ledger: %v", err)
		}
	}
	return res, body
}

// TestBoardLedgerMatchesServedOrder is the assertion that matters. The frontend
// renders the websocket's events in arrival order and looks their sats up in
// this ledger, so if the two ever disagree about ranking, the board shows one
// order with another order's numbers beside it.
func TestBoardLedgerMatchesServedOrder(t *testing.T) {
	storage := newTestStorage(t)

	base := time.Now().Add(-24 * time.Hour)
	seedPaidNote(t, storage, "cheapest", 6, base)
	seedPaidNote(t, storage, "richest", 63, base)
	seedPaidNote(t, storage, "middle", 20, base)
	// Same sats as "middle", but paid more recently, so it must sort above it.
	seedPaidNote(t, storage, "middle but fresher", 20, base.Add(time.Hour))

	_, body := fetchLedger(t, storage, http.MethodGet)

	if body.Posts != 4 {
		t.Fatalf("posts = %d, want 4", body.Posts)
	}
	if body.TotalSats != 6+63+20+20 {
		t.Errorf("total_sats = %d, want 109", body.TotalSats)
	}

	wantSats := []int64{63, 20, 20, 6}
	for i, entry := range body.Entries {
		if entry.Rank != i+1 {
			t.Errorf("entry %d has rank %d, want %d", i, entry.Rank, i+1)
		}
		if entry.SatsPaid != wantSats[i] {
			t.Errorf("rank %d has %d sats, want %d", entry.Rank, entry.SatsPaid, wantSats[i])
		}
	}

	// The tie between the two 20 sat notes must break towards the fresher one.
	fresher, _ := storage.GetPost(body.Entries[1].ID)
	older, _ := storage.GetPost(body.Entries[2].ID)
	if fresher.Event.Content != "middle but fresher" || older.Event.Content != "middle" {
		t.Errorf("tie broken the wrong way: rank 2 is %q, rank 3 is %q",
			fresher.Event.Content, older.Event.Content)
	}

	// And the whole thing has to line up with what the websocket serves.
	served := storage.QueryPosts(context.Background(), nostr.Filter{Kinds: []int{1}})
	if len(served) != len(body.Entries) {
		t.Fatalf("relay serves %d events but the ledger lists %d", len(served), len(body.Entries))
	}
	for i, event := range served {
		if event.ID != body.Entries[i].ID {
			t.Errorf("position %d: relay serves %s, ledger says %s",
				i, short(event.ID, 8), short(body.Entries[i].ID, 8))
		}
	}
}

func TestBoardLedgerEmptyBoard(t *testing.T) {
	storage := newTestStorage(t)

	res, body := fetchLedger(t, storage, http.MethodGet)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if body.Posts != 0 || body.TotalSats != 0 {
		t.Errorf("posts = %d, total = %d, want 0 and 0", body.Posts, body.TotalSats)
	}
	// An empty board must serialise as [], not null, or the client has to
	// special-case it.
	if body.Entries == nil {
		t.Error("entries should be an empty array, not null")
	}
}

func TestBoardLedgerRejectsWrites(t *testing.T) {
	storage := newTestStorage(t)

	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		res, _ := fetchLedger(t, storage, method)
		if res.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("%s returned %d, want 405", method, res.StatusCode)
		}
		if allow := res.Header.Get("Allow"); allow != "GET, HEAD" {
			t.Errorf("%s Allow header = %q", method, allow)
		}
	}
}

func TestBoardLedgerHeadHasNoBody(t *testing.T) {
	storage := newTestStorage(t)
	seedPaidNote(t, storage, "one", 21, time.Now())

	req := httptest.NewRequest(http.MethodHead, "/api/board", nil)
	rec := httptest.NewRecorder()
	BoardHandler(storage)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("HEAD returned %d bytes of body", rec.Body.Len())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("content type = %q", ct)
	}
}
