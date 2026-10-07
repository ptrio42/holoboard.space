package main

import (
	"context"
	"fmt"
	"testing"
	"time"

	"fiatjaf.com/nostr"
)

func TestQuoteSplitsUseVerifiedRecipientProfileRelays(t *testing.T) {
	previousDiscovery := discoveryRelays
	discoveryRelays = nil
	t.Cleanup(func() { discoveryRelays = previousDiscovery })
	boardRelay, noteRelay, authorRelay := startTestRelay(t), startTestRelay(t), startTestRelay(t)
	storage, publisher, note := accountPublicationFixture(t, boardRelay)
	publisher.profile = findRecipientProfile
	authorKey := generatePrivateKey()
	if err := signEvent(note, authorKey); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	for _, fixture := range []struct {
		relay, key, content string
		kind                int
		tags                nostr.Tags
	}{
		{boardRelay, publisher.relayPrivkey, `{"lud16":"board@wallet.example"}`, 0, nostr.Tags{}},
		{authorRelay, authorKey, `{"lud16":"author@wallet.example"}`, 0, nostr.Tags{}},
		{noteRelay, authorKey, "", kindRelayList, nostr.Tags{{"r", authorRelay, "write"}}},
	} {
		connection, err := nostr.RelayConnect(ctx, fixture.relay)
		if err != nil {
			t.Fatal(err)
		}
		event := nostr.Event{Kind: nostr.Kind(fixture.kind), CreatedAt: nostr.Now(), Tags: fixture.tags, Content: fixture.content}
		if err := signEvent(&event, fixture.key); err != nil {
			t.Fatal(err)
		}
		if err := connection.Publish(ctx, event); err != nil {
			t.Fatal(err)
		}
		connection.Close()
	}
	quote, err := publisher.BuildQuoteWithSplit(note, noteRelay, 30)
	if err != nil {
		t.Fatal(err)
	}
	if valid, err := verifyNostrEvent(quote); err != nil || !valid {
		t.Fatalf("quote signature: %v %v", valid, err)
	}
	splits := collectTags(quote.Tags, "zap")
	if len(splits) != 2 || fmt.Sprint(splits[0]) != fmt.Sprint(nostr.Tag{"zap", publisher.relayPubkey, boardRelay, "70"}) || fmt.Sprint(splits[1]) != fmt.Sprint(nostr.Tag{"zap", note.PubKey.Hex(), authorRelay, "30"}) {
		t.Fatalf("recipient profile sources: %v", splits)
	}
	// A client following each hint can retrieve that recipient's payment profile.
	for _, split := range splits {
		if got := queryPaymentProfileRelay(ctx, split[1], []string{split[2]}); got != split[2] {
			t.Fatalf("unusable profile hint %v", split)
		}
	}
	if _, err := storage.CreditZapWithPublication(note.ID.Hex(), 21, note, "first", "first-hash", quote, publisher.Targets()); err != nil {
		t.Fatal(err)
	}
	if err := storage.MarkAccountPublicationDelivered(quotePublicationKey(note.ID.Hex()), quote.ID.Hex(), publisher.Targets()); err != nil {
		t.Fatal(err)
	}
	for _, payment := range []string{"boost", "revival"} {
		if payment == "revival" {
			for i := range storage.posts[note.ID.Hex()].Payments {
				storage.posts[note.ID.Hex()].Payments[i].At = time.Now().Add(-2 * 365 * 24 * time.Hour)
			}
		}
		replacement := cloneNostrEvent(quote)
		replacement.Tags = append(replacement.Tags, nostr.Tag{"changed", payment})
		if err := signEvent(replacement, publisher.relayPrivkey); err != nil {
			t.Fatal(err)
		}
		if _, err := storage.CreditZapWithPublication(note.ID.Hex(), 1, note, payment, payment+"-hash", replacement, publisher.Targets()); err != nil {
			t.Fatal(err)
		}
	}
	loaded, err := NewStorage(storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	record, _ := loaded.QuotePublication(note.ID.Hex())
	post, _ := loaded.GetPost(note.ID.Hex())
	if record.Event.ID.Hex() != quote.ID.Hex() || campaignAuthorShare(post) != 30 {
		t.Fatal("boost, revival or restart changed the public quote or split")
	}
}

func TestQuoteMissingProfileDoesNotInventRelayOrRedirectAuthorShare(t *testing.T) {
	_, publisher, note := accountPublicationFixture(t, "wss://publication.example")
	quote, err := publisher.BuildQuoteWithSplit(note, "wss://note.example", 20)
	if err != nil {
		t.Fatal(err)
	}
	splits := collectTags(quote.Tags, "zap")
	if len(splits) != 2 || splits[0][2] != "" || splits[1][2] != "" || splits[1][1] != note.PubKey.Hex() || splits[1][3] != "20" {
		t.Fatalf("unverified sources or redirected author support: %v", splits)
	}
}
