package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"
)

func TestWaitingUpdatesCountAllPagesAndOnlyFirstPromotions(t *testing.T) {
	s := newTestStorage(t)
	since := time.Now().Add(-time.Second).Truncate(time.Millisecond)
	for i := 0; i < 21; i++ {
		id := seedPaidNote(t, s, fmt.Sprintf("leader %d", i), 10000, time.Now())
		s.posts[id].FirstPromotedAt = since.Add(-time.Hour)
		if i == 0 {
			s.posts[id].FirstPromotedAt = since.Add(time.Millisecond)
		}
	}
	wanted := make(map[string]bool)
	for i := 0; i < 25; i++ {
		id := seedPaidNote(t, s, fmt.Sprintf("new %d", i), 100, time.Now())
		s.posts[id].FirstPromotedAt = since.Add(time.Millisecond)
		wanted[id] = true
	}
	for _, label := range []string{"old boost", "fallen from top", "boundary"} {
		id := seedPaidNote(t, s, label, 21, time.Now())
		s.posts[id].FirstPromotedAt = since
	}
	removed := seedPaidNote(t, s, "removed", 21, time.Now())
	s.posts[removed].FirstPromotedAt = since.Add(time.Millisecond)
	s.removed[removed] = true
	expired := seedPaidNote(t, s, "expired", 21, time.Now())
	s.posts[expired].FirstPromotedAt = since.Add(time.Millisecond)
	for i := range s.posts[expired].Payments {
		s.posts[expired].Payments[i].At = time.Now().Add(-20 * rankHalfLife)
	}
	handler := WaitingUpdatesHandler(s)
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest("GET", fmt.Sprintf("/api/board/waiting-updates?since=%d", since.UnixMilli()), nil))
	var result struct {
		Count     int      `json:"count"`
		NoteIDs   []string `json:"note_ids"`
		CheckedAt int64    `json:"checked_at"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if rec.Code != 200 || result.Count != 25 || len(result.NoteIDs) != 25 || result.CheckedAt < since.UnixMilli() {
		t.Fatalf("unexpected updates: %s", rec.Body.String())
	}
	for _, id := range result.NoteIDs {
		if !wanted[id] {
			t.Fatalf("old, expired, removed or top-21 note counted: %s", id)
		}
		delete(wanted, id)
	}
	if len(wanted) != 0 {
		t.Fatal("missed newly promoted notes beyond the first page")
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("visit responses must not be cached")
	}
	rec = httptest.NewRecorder()
	handler(rec, httptest.NewRequest("GET", "/api/board/waiting-updates", nil))
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Count != 0 || len(result.NoteIDs) != 0 {
		t.Fatal("first visit must establish a baseline, not flag existing notes")
	}
}

func TestWaitingUpdatesRejectInvalidCursorsAndMethods(t *testing.T) {
	handler := WaitingUpdatesHandler(newTestStorage(t))
	for _, query := range []string{"-1", "abc", "1.2", "999999999999999999999999", fmt.Sprint(time.Now().Add(time.Hour).UnixMilli())} {
		rec := httptest.NewRecorder()
		handler(rec, httptest.NewRequest("GET", "/api/board/waiting-updates?since="+query, nil))
		if rec.Code != 400 {
			t.Fatalf("accepted invalid cursor %q", query)
		}
	}
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest("POST", "/api/board/waiting-updates", nil))
	if rec.Code != 405 || rec.Header().Get("Allow") != "GET, HEAD" {
		t.Fatal("unexpected method support")
	}
}

func TestCampaignResponseIncludesSnapshotTimestamp(t *testing.T) {
	rec := httptest.NewRecorder()
	before := time.Now().UnixMilli()
	CampaignHandler(newTestStorage(t))(rec, httptest.NewRequest("GET", "/api/board/campaigns", nil))
	var result struct {
		CheckedAt int64 `json:"checked_at"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.CheckedAt < before || result.CheckedAt > time.Now().UnixMilli() {
		t.Fatal("campaign response lacks a server snapshot checkpoint")
	}
}
