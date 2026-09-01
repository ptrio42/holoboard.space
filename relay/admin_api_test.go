package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nbd-wtf/go-nostr"
)

const testAdminToken = "s3cret-operator-token"

func postAdmin(t *testing.T, handler http.HandlerFunc, body adminRequest, auth string) *httptest.ResponseRecorder {
	t.Helper()

	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("failed to encode body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/admin/note", bytes.NewReader(encoded))
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}

	rec := httptest.NewRecorder()
	handler(rec, req)
	return rec
}

func TestAdminRequiresTheToken(t *testing.T) {
	storage := newTestStorage(t)
	postID := seedPromotedPost(t, storage, nostr.GeneratePrivateKey())
	handler := AdminHandler(storage, testAdminToken)

	for _, auth := range []string{"", "Bearer", "Bearer wrong", "Basic " + testAdminToken, testAdminToken} {
		rec := postAdmin(t, handler, adminRequest{Note: postID}, auth)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("auth %q returned %d, want 401", auth, rec.Code)
		}
	}

	// And nothing was removed along the way.
	if _, exists := storage.GetPost(postID); !exists {
		t.Error("the post was removed by an unauthorised request")
	}
}

// An empty token must not turn into an endpoint anyone can call. main.go does
// not register the handler in that case, and this pins the second line too.
func TestAdminRefusesWhenNoTokenIsConfigured(t *testing.T) {
	storage := newTestStorage(t)
	postID := seedPromotedPost(t, storage, nostr.GeneratePrivateKey())

	rec := postAdmin(t, AdminHandler(storage, ""), adminRequest{Note: postID}, "Bearer ")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status %d, want 401", rec.Code)
	}
}

func TestAdminRemovesANote(t *testing.T) {
	storage := newTestStorage(t)
	seckey := nostr.GeneratePrivateKey()
	postID := seedPromotedPost(t, storage, seckey)

	// Give it a rank worth reporting back.
	if err := storage.AddPayment(postID, 420, nil); err != nil {
		t.Fatalf("failed to seed sats: %v", err)
	}

	handler := AdminHandler(storage, testAdminToken)
	rec := postAdmin(t, handler, adminRequest{Note: postID}, "Bearer "+testAdminToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
	}

	var out adminResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("failed to decode: %v", err)
	}
	if out.Status != "removed" {
		t.Errorf("status = %q, want removed", out.Status)
	}
	if out.SatsRemoved != 421 {
		t.Errorf("sats removed = %d, want 421 (the seeded 1 plus 420)", out.SatsRemoved)
	}

	if _, exists := storage.GetPost(postID); exists {
		t.Error("the post is still on the board")
	}
	for _, entry := range storage.Ledger() {
		if entry.ID == postID {
			t.Error("the removed post is still in the ledger the board is built from")
		}
	}
}

// The point of the blocklist: paying again must not undo a removal.
func TestRemovedNoteCannotBePaidBack(t *testing.T) {
	storage := newTestStorage(t)
	seckey := nostr.GeneratePrivateKey()
	postID := seedPromotedPost(t, storage, seckey)

	event := storagePostEvent(t, storage, postID)
	if _, err := storage.RemovePost(postID); err != nil {
		t.Fatalf("failed to remove: %v", err)
	}

	if err := storage.AddPayment(postID, 100_000, event); err == nil {
		t.Fatal("a removed note was put back by paying for it")
	}
	if _, exists := storage.GetPost(postID); exists {
		t.Error("the removed note reappeared on the board")
	}

	// Restoring lifts the block, and the note has to earn its rank over.
	if err := storage.RestorePost(postID); err != nil {
		t.Fatalf("failed to restore: %v", err)
	}
	if err := storage.AddPayment(postID, 50, event); err != nil {
		t.Fatalf("a restored note should be promotable again: %v", err)
	}
	post, exists := storage.GetPost(postID)
	if !exists {
		t.Fatal("the restored note did not come back after payment")
	}
	if post.TotalSatsPaid != 50 {
		t.Errorf("total = %d sats, want only the 50 paid since; the old total is gone with the entry",
			post.TotalSatsPaid)
	}
}

// A removal has to survive a restart, or it is not a removal.
func TestRemovalSurvivesReload(t *testing.T) {
	storage := newTestStorage(t)
	postID := seedPromotedPost(t, storage, nostr.GeneratePrivateKey())
	if _, err := storage.RemovePost(postID); err != nil {
		t.Fatalf("failed to remove: %v", err)
	}

	reopened, err := NewStorage(storage.dataFile)
	if err != nil {
		t.Fatalf("failed to reopen storage: %v", err)
	}
	if !reopened.IsRemoved(postID) {
		t.Error("the removal was forgotten across a restart")
	}
	if _, exists := reopened.GetPost(postID); exists {
		t.Error("the removed post came back after a restart")
	}
}

func TestAdminRestoreNeedsAnActualRemoval(t *testing.T) {
	storage := newTestStorage(t)
	postID := seedPromotedPost(t, storage, nostr.GeneratePrivateKey())

	rec := postAdmin(t, AdminHandler(storage, testAdminToken),
		adminRequest{Note: postID, Restore: true}, "Bearer "+testAdminToken)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status %d, want 404 for a note that was never removed", rec.Code)
	}
}

// storagePostEvent digs out the signed event a seeded post carries, so a test
// can re-offer it to AddPayment the way the payment path would.
func storagePostEvent(t *testing.T, storage *Storage, postID string) *nostr.Event {
	t.Helper()

	post, exists := storage.GetPost(postID)
	if !exists {
		t.Fatalf("post %s is not in storage", short(postID, 8))
	}
	return post.Event
}
