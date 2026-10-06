package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsutil"
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

	for _, form := range []string{nevent, "nostr:" + nevent, "  " + nevent + " ", "https://njump.me/" + nevent} {
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

func TestFetchPostUsesOutboxWhileCandidatesAreUnresponsive(t *testing.T) {
	previous := discoveryRelays
	discoveryRelays = nil
	t.Cleanup(func() { discoveryRelays = previous })
	index, outbox := startTestRelay(t), startTestRelay(t)
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, _, _, err := ws.UpgradeHTTP(r, w)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			if _, _, err := wsutil.ReadClientData(conn); err != nil {
				return
			}
		}
	}))
	defer slow.Close()
	key := nostr.GeneratePrivateKey()
	note := &nostr.Event{Kind: 1, CreatedAt: nostr.Now(), Content: "Only on the author's outbox", Tags: nostr.Tags{}}
	if err := note.Sign(key); err != nil {
		t.Fatal(err)
	}
	list := &nostr.Event{Kind: kindRelayList, CreatedAt: nostr.Now(), Tags: nostr.Tags{{"r", outbox, "write"}}}
	if err := list.Sign(key); err != nil {
		t.Fatal(err)
	}
	for source, event := range map[string]*nostr.Event{index: list, outbox: note} {
		connection, err := nostr.RelayConnect(context.Background(), source)
		if err != nil {
			t.Fatal(err)
		}
		err = connection.Publish(context.Background(), *event)
		connection.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	fetcher := NewPostFetcher([]string{index, "ws" + strings.TrimPrefix(slow.URL, "http")})
	event, source, err := fetcher.FetchPostFromWithRelay(ctx, note.ID, nil, note.PubKey)
	if err != nil || event == nil || event.ID != note.ID || source != outbox {
		t.Fatalf("outbox lookup blocked by a slow candidate: event=%v source=%q err=%v", event, source, err)
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

// Every route into the board ends up fetching the note a second time when the
// payment settles, and each of them has the reference to hand at that point.
// This pins that they all pass it on, since losing it there is invisible until
// somebody has already paid.
func TestEveryPathCarriesHintsToSettlement(t *testing.T) {
	id := "5555555555555555555555555555555555555555555555555555555555555555"
	author := "6666666666666666666666666666666666666666666666666666666666666666"
	relays := []string{"wss://elsewhere.example.com"}

	nevent, err := nip19.EncodeEvent(id, relays, author)
	if err != nil {
		t.Fatalf("failed to encode: %v", err)
	}

	// A zap comment, a mention body and a pasted form all reach noteHints via
	// extractEventIDFromText, so the extraction has to survive surrounding text.
	for _, surrounding := range []string{
		nevent,
		"nostr:" + nevent,
		"promote this one please nostr:" + nevent + " thanks",
		"@holoboard " + nevent,
	} {
		extracted := extractEventIDFromText(surrounding)
		gotRelays, gotAuthor := noteHints(extracted)
		if len(gotRelays) != 1 || gotRelays[0] != relays[0] {
			t.Errorf("%.30s lost the relay hint: %v", surrounding, gotRelays)
		}
		if gotAuthor != author {
			t.Errorf("%.30s lost the author", surrounding)
		}
		if normalizeEventID(extracted) != id {
			t.Errorf("%.30s did not resolve to the id", surrounding)
		}
	}
}
