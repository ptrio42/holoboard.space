package main

import (
	"context"
	"testing"

	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip19"
)

// An nevent carries relay hints and an author precisely so a reader does not
// have to already know where the note lives. Throwing them away is how a note
// that exists gets reported as not existing.
func TestNoteHints(t *testing.T) {
	id := "1111111111111111111111111111111111111111111111111111111111111111"
	author := "2222222222222222222222222222222222222222222222222222222222222222"
	relays := []string{"wss://relay.example.com", "wss://other.example.com"}

	nevent, err := nip19.EncodeEvent(id, relays, author)
	if err != nil {
		t.Fatalf("failed to encode: %v", err)
	}

	for _, form := range []string{nevent, "nostr:" + nevent, "  " + nevent + " "} {
		gotRelays, gotAuthor := noteHints(form)
		if len(gotRelays) != len(relays) {
			t.Errorf("%.20s gave %d relays, want %d", form, len(gotRelays), len(relays))
		}
		if gotAuthor != author {
			t.Errorf("%.20s gave author %s, want %s", form, short(gotAuthor, 8), short(author, 8))
		}
	}

	// A note1 or a bare id carries neither, and must not pretend otherwise.
	note, err := nip19.EncodeNote(id)
	if err != nil {
		t.Fatalf("failed to encode: %v", err)
	}
	for _, bare := range []string{note, id, "", "nonsense", "nevent1notreal"} {
		gotRelays, gotAuthor := noteHints(bare)
		if len(gotRelays) != 0 || gotAuthor != "" {
			t.Errorf("%.20s invented hints: %v %s", bare, gotRelays, gotAuthor)
		}
	}
}

// An nevent with no hints in it must still resolve to its id, rather than
// failing because there was nothing to extract.
func TestNeventWithoutHintsStillResolves(t *testing.T) {
	id := "3333333333333333333333333333333333333333333333333333333333333333"

	nevent, err := nip19.EncodeEvent(id, nil, "")
	if err != nil {
		t.Fatalf("failed to encode: %v", err)
	}

	if got := normalizeEventID(nevent); got != id {
		t.Errorf("normalizeEventID gave %s, want the id", short(got, 8))
	}
	relays, author := noteHints(nevent)
	if len(relays) != 0 || author != "" {
		t.Errorf("hints were invented: %v %s", relays, author)
	}
}

// With nowhere to look and nobody to ask, the fetcher says so instead of
// hanging or claiming success.
func TestFetchPostFromNeedsSomewhereToLook(t *testing.T) {
	fetcher := NewPostFetcher(nil)

	if _, err := fetcher.FetchPostFrom(context.Background(), "abc", nil, ""); err == nil {
		t.Error("fetching with no relays and no author should fail")
	}
}

// The hints are stored with the invoice, because the note is fetched again when
// it settles and by then the pasted reference is long gone.
func TestInvoiceKeepsTheHints(t *testing.T) {
	storage := newTestStorage(t)
	postID := seedPromotedPost(t, storage, nostr.GeneratePrivateKey())

	monitor := NewPaymentMonitor(storage, "relay", NewPostFetcher(nil), NewLNURLResolver())
	invoices := NewInvoiceManager(NewMockLightningBackend(), storage, monitor, 1000)

	hints := []string{"wss://relay.example.com"}
	author := "4444444444444444444444444444444444444444444444444444444444444444"

	invoice, err := invoices.GeneratePromotionInvoice(context.Background(), postID, 500, hints, author)
	if err != nil {
		t.Fatalf("failed to mint: %v", err)
	}

	stored, waiting := storage.GetPendingInvoice(invoice.PaymentHash)
	if !waiting {
		t.Fatal("the invoice was not recorded")
	}
	if len(stored.RelayHints) != 1 || stored.RelayHints[0] != hints[0] {
		t.Errorf("relay hints = %v, want %v", stored.RelayHints, hints)
	}
	if stored.Author != author {
		t.Errorf("author = %s, want %s", short(stored.Author, 8), short(author, 8))
	}
}
