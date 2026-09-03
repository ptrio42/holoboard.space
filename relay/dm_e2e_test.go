package main

import (
	"context"
	"testing"

	"github.com/nbd-wtf/go-nostr"
)

// TestRemoveOverGiftWrapEndToEnd runs the whole path the operator will use:
// a NIP-17 message is built the way a client builds one, handed to the monitor
// exactly as it would arrive off a relay, and the note comes off the board.
//
// The forgery case is the one that matters, so it runs against the same path:
// an identical message from anyone else must change nothing.
func TestRemoveOverGiftWrapEndToEnd(t *testing.T) {
	dm, storage, postID := adminFixture(t)

	adminPrivkey := nostr.GeneratePrivateKey()
	adminPubkey, _ := nostr.GetPublicKey(adminPrivkey)
	dm.WithAdmin(adminPubkey)

	// Someone else sends the identical command first.
	impostorWrap, err := wrapMessage("REMOVE "+postID, dm.relayPubkey, nostr.GeneratePrivateKey(), "")
	if err != nil {
		t.Fatalf("failed to wrap: %v", err)
	}
	if err := dm.processDM(context.Background(), impostorWrap); err != nil {
		t.Fatalf("processing should not error: %v", err)
	}
	if _, exists := storage.GetPost(postID); !exists {
		t.Fatal("a gift wrapped REMOVE from a stranger took the note down")
	}

	// Now the operator.
	wrap, err := wrapMessage("REMOVE "+postID, dm.relayPubkey, adminPrivkey, "")
	if err != nil {
		t.Fatalf("failed to wrap: %v", err)
	}
	if wrap.Kind != kindGiftWrap {
		t.Fatalf("kind = %d, want a gift wrap", wrap.Kind)
	}

	// The reply cannot publish with no relays configured; the board change is
	// what is under test.
	_ = dm.processDM(context.Background(), wrap)

	if _, exists := storage.GetPost(postID); exists {
		t.Error("the operator's gift wrapped REMOVE did not take the note down")
	}
	if !storage.IsRemoved(postID) {
		t.Error("the note was not blocked, so paying again would put it back")
	}
}

// A gift wrap whose inner message is older than the resume point must be
// ignored, or a restart answers two days of stale requests with real invoices.
func TestStaleGiftWrapIsIgnored(t *testing.T) {
	dm, storage, postID := adminFixture(t)

	adminPrivkey := nostr.GeneratePrivateKey()
	adminPubkey, _ := nostr.GetPublicKey(adminPrivkey)
	dm.WithAdmin(adminPubkey)

	wrap, err := wrapMessage("REMOVE "+postID, dm.relayPubkey, adminPrivkey, "")
	if err != nil {
		t.Fatalf("failed to wrap: %v", err)
	}

	// Rather than forge an old timestamp inside a sealed message, move the
	// resume point past it. The comparison under test is the same one either
	// way: the rumor's honest time against the cutoff.
	if err := storage.AdvanceDMWatermark(int64(nostr.Now()) + 3600); err != nil {
		t.Fatalf("failed to advance the watermark: %v", err)
	}

	if err := dm.processDM(context.Background(), wrap); err != nil {
		t.Fatalf("processing should not error: %v", err)
	}
	if _, exists := storage.GetPost(postID); !exists {
		t.Error("a message from before the resume point was acted on")
	}
}
