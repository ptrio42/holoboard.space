package main

import (
	"context"
	"testing"

	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip19"
)

// adminFixture builds a monitor with no relays, so replies fail to publish and
// nothing here reaches the network. What is under test is who is allowed to
// change the board, not whether the confirmation was delivered.
func adminFixture(t *testing.T) (*DMMonitor, *Storage, string) {
	t.Helper()

	storage := newTestStorage(t)
	postID := seedPromotedPost(t, storage, nostr.GeneratePrivateKey())

	monitor := NewPaymentMonitor(storage, "relay", NewPostFetcher(nil), NewLNURLResolver())
	invoices := NewInvoiceManager(NewMockLightningBackend(), storage, monitor, 1000)

	relayPrivkey := nostr.GeneratePrivateKey()
	relayPubkey, _ := nostr.GetPublicKey(relayPrivkey)

	dm := NewDMMonitor(nil, relayPubkey, relayPrivkey, invoices, storage)
	return dm, storage, postID
}

func TestOnlyTheAdminCanRemove(t *testing.T) {
	dm, storage, postID := adminFixture(t)

	adminPrivkey := nostr.GeneratePrivateKey()
	adminPubkey, _ := nostr.GetPublicKey(adminPrivkey)
	dm.WithAdmin(adminPubkey)

	strangerPubkey, _ := nostr.GetPublicKey(nostr.GeneratePrivateKey())

	// A stranger asking is ignored, and told nothing.
	if err := dm.handleCommand(context.Background(), strangerPubkey, "REMOVE "+postID, true); err != nil {
		t.Fatalf("a refused command should not error: %v", err)
	}
	if _, exists := storage.GetPost(postID); !exists {
		t.Fatal("a stranger removed a note")
	}
	if storage.IsRemoved(postID) {
		t.Fatal("a stranger's REMOVE marked the note as removed")
	}

	// The operator asking works. The reply cannot be published with no relays
	// configured, which is expected and is not what this asserts.
	_ = dm.handleCommand(context.Background(), adminPubkey, "REMOVE "+postID, true)
	if _, exists := storage.GetPost(postID); exists {
		t.Error("the operator's REMOVE did not take the note down")
	}
	if !storage.IsRemoved(postID) {
		t.Error("the note was dropped but not blocked, so paying would put it back")
	}
}

func TestNoAdminConfiguredMeansNobodyCanRemove(t *testing.T) {
	dm, storage, postID := adminFixture(t)

	// Not even an empty pubkey, which is what an unset ADMIN_PUBKEY would be.
	for _, sender := range []string{"", dm.relayPubkey} {
		if err := dm.handleCommand(context.Background(), sender, "REMOVE "+postID, true); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if _, exists := storage.GetPost(postID); !exists {
		t.Error("a note was removed with no admin configured")
	}
}

func TestAdminRestoreByDM(t *testing.T) {
	dm, storage, postID := adminFixture(t)

	adminPubkey, _ := nostr.GetPublicKey(nostr.GeneratePrivateKey())
	dm.WithAdmin(adminPubkey)

	_ = dm.handleCommand(context.Background(), adminPubkey, "REMOVE "+postID, true)
	if !storage.IsRemoved(postID) {
		t.Fatal("setup failed: the note was not removed")
	}

	_ = dm.handleCommand(context.Background(), adminPubkey, "RESTORE "+postID, true)
	if storage.IsRemoved(postID) {
		t.Error("RESTORE did not lift the block")
	}
}

// The command has to accept what a person would actually paste.
func TestAdminAcceptsPastedReferences(t *testing.T) {
	dm, storage, postID := adminFixture(t)

	adminPubkey, _ := nostr.GetPublicKey(nostr.GeneratePrivateKey())
	dm.WithAdmin(adminPubkey)

	encoded, err := nip19.EncodeNote(postID)
	if err != nil {
		t.Fatalf("failed to encode: %v", err)
	}

	_ = dm.handleCommand(context.Background(), adminPubkey, "REMOVE https://njump.me/"+encoded, true)
	if !storage.IsRemoved(postID) {
		t.Error("a pasted njump link was not understood")
	}
}

// An unknown message must not be answered at all, or the relay becomes a way to
// send mail to strangers.
func TestUnknownCommandsAreIgnored(t *testing.T) {
	dm, _, _ := adminFixture(t)

	for _, text := range []string{"", "hello there", "REMOVEALL", "gm"} {
		if err := dm.handleCommand(context.Background(), "somebody", text, true); err != nil {
			t.Errorf("%q produced an error instead of being ignored: %v", text, err)
		}
	}
}

func TestNormalizePubkey(t *testing.T) {
	privkey := nostr.GeneratePrivateKey()
	pubkey, _ := nostr.GetPublicKey(privkey)
	npub, err := nip19.EncodePublicKey(pubkey)
	if err != nil {
		t.Fatalf("failed to encode: %v", err)
	}

	for _, input := range []string{pubkey, npub, "nostr:" + npub, "  " + npub + "  "} {
		got, err := normalizePubkey(input)
		if err != nil {
			t.Errorf("%.20s failed: %v", input, err)
			continue
		}
		if got != pubkey {
			t.Errorf("%.20s resolved to %s, want %s", input, short(got, 8), short(pubkey, 8))
		}
	}

	note, _ := nip19.EncodeNote(pubkey)
	for _, bad := range []string{"", "nonsense", "npub1notreal", note} {
		if _, err := normalizePubkey(bad); err == nil {
			t.Errorf("%q was accepted as a pubkey", bad)
		}
	}
}
