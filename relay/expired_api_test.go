package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

func expiredPage(t *testing.T, storage *Storage, query string) expiredResponse {
	t.Helper()
	recorder := httptest.NewRecorder()
	ExpiredHandler(storage)(recorder, httptest.NewRequest("GET", "/api/board/expired"+query, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("archive returned %d: %s", recorder.Code, recorder.Body.String())
	}
	var page expiredResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	return page
}

func TestExpiredArchivePaginationAndRevival(t *testing.T) {
	storage := newTestStorage(t)
	paidAt := time.Now().Add(-10 * rankHalfLife)
	first := seedPaidPost(t, storage, 100, paidAt)
	second := seedPaidPost(t, storage, 100, paidAt)
	if first > second {
		first, second = second, first
	}
	removed := seedPaidPost(t, storage, 100, paidAt)
	if _, err := storage.RemovePost(removed); err != nil {
		t.Fatal(err)
	}
	seedPaidPost(t, storage, 100, time.Now())
	page := expiredPage(t, storage, "?limit=1")
	if len(page.Entries) != 1 || page.Entries[0].Event.ID != first || page.Entries[0].SatsPaid != 100 || page.NextCursor == "" {
		t.Fatalf("unexpected first archive page: %+v", page)
	}
	if valid, err := page.Entries[0].Event.CheckSignature(); err != nil || !valid {
		t.Fatal("archive changed the signed event")
	}
	if err := storage.AddPayment(first, 20, nil); err != nil {
		t.Fatal(err)
	}
	next := expiredPage(t, storage, "?limit=1&cursor="+url.QueryEscape(page.NextCursor))
	if len(next.Entries) != 1 || next.Entries[0].Event.ID != second || next.NextCursor != "" {
		t.Fatalf("reviving the cursor note skipped a page: %+v", next)
	}
	if len(storage.QueryPosts(context.Background(), nostr.Filter{IDs: []string{second}})) != 0 {
		t.Fatal("archive note leaked into the active feed")
	}
	if err := storage.AddPayment(second, 20, nil); err != nil {
		t.Fatal(err)
	}
	if page := expiredPage(t, storage, ""); len(page.Entries) != 0 || page.Entries == nil {
		t.Fatal("empty archive should return an empty array")
	}
}

func TestExpiredArchiveRejectsInvalidRequests(t *testing.T) {
	storage := newTestStorage(t)
	for _, query := range []string{"?limit=0", "?limit=51", "?limit=no", "?cursor=broken"} {
		recorder := httptest.NewRecorder()
		ExpiredHandler(storage)(recorder, httptest.NewRequest("GET", "/api/board/expired"+query, nil))
		if recorder.Code != http.StatusBadRequest {
			t.Errorf("%s returned %d", query, recorder.Code)
		}
	}
	recorder := httptest.NewRecorder()
	ExpiredHandler(storage)(recorder, httptest.NewRequest("POST", "/api/board/expired", nil))
	if recorder.Code != http.StatusMethodNotAllowed || recorder.Header().Get("Allow") != "GET, HEAD" {
		t.Fatal("archive should accept only GET and HEAD")
	}
}
