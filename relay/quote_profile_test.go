package main

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

func TestQuoteSplitsUseVerifiedRecipientProfileRelays(t *testing.T) {
	previousDiscovery := discoveryRelays
	discoveryRelays = nil
	t.Cleanup(func() { discoveryRelays = previousDiscovery })
	boardRelay, noteRelay, authorRelay := startTestRelay(t), startTestRelay(t), startTestRelay(t)
	storage, publisher, note := accountPublicationFixture(t, boardRelay)
	publisher.profile = findRecipientProfile
	authorKey := nostr.GeneratePrivateKey()
	if err := note.Sign(authorKey); err != nil {
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
		event := nostr.Event{Kind: fixture.kind, CreatedAt: nostr.Now(), Tags: fixture.tags, Content: fixture.content}
		if err := event.Sign(fixture.key); err != nil {
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
	if valid, err := quote.CheckSignature(); err != nil || !valid {
		t.Fatalf("quote signature: %v %v", valid, err)
	}
	splits := quote.Tags.GetAll([]string{"zap"})
	if len(splits) != 2 || fmt.Sprint(splits[0]) != fmt.Sprint(nostr.Tag{"zap", publisher.relayPubkey, boardRelay, "70"}) || fmt.Sprint(splits[1]) != fmt.Sprint(nostr.Tag{"zap", note.PubKey, authorRelay, "30"}) {
		t.Fatalf("recipient profile sources: %v", splits)
	}
	// A client following each hint can retrieve that recipient's payment profile.
	for _, split := range splits {
		if got := queryPaymentProfileRelay(ctx, split[1], []string{split[2]}); got != split[2] {
			t.Fatalf("unusable profile hint %v", split)
		}
	}
	if _, err := storage.CreditZapWithPublication(note.ID, 21, note, "first", "first-hash", quote, publisher.Targets()); err != nil {
		t.Fatal(err)
	}
	if err := storage.MarkAccountPublicationDelivered(quotePublicationKey(note.ID), quote.ID, publisher.Targets()); err != nil {
		t.Fatal(err)
	}
	for _, payment := range []string{"boost", "revival"} {
		if payment == "revival" {
			for i := range storage.posts[note.ID].Payments {
				storage.posts[note.ID].Payments[i].At = time.Now().Add(-2 * 365 * 24 * time.Hour)
			}
		}
		replacement := cloneNostrEvent(quote)
		replacement.Tags = append(replacement.Tags, nostr.Tag{"changed", payment})
		if err := replacement.Sign(publisher.relayPrivkey); err != nil {
			t.Fatal(err)
		}
		if _, err := storage.CreditZapWithPublication(note.ID, 1, note, payment, payment+"-hash", replacement, publisher.Targets()); err != nil {
			t.Fatal(err)
		}
	}
	loaded, err := NewStorage(storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	record, _ := loaded.QuotePublication(note.ID)
	post, _ := loaded.GetPost(note.ID)
	if record.Event.ID != quote.ID || campaignAuthorShare(post) != 30 {
		t.Fatal("boost, revival or restart changed the public quote or split")
	}
}

func TestQuoteMissingProfileDoesNotInventRelayOrRedirectAuthorShare(t *testing.T) {
	_, publisher, note := accountPublicationFixture(t, "wss://publication.example")
	quote, err := publisher.BuildQuoteWithSplit(note, "wss://note.example", 20)
	if err != nil {
		t.Fatal(err)
	}
	splits := quote.Tags.GetAll([]string{"zap"})
	if len(splits) != 2 || splits[0][2] != "" || splits[1][2] != "" || splits[1][1] != note.PubKey || splits[1][3] != "20" {
		t.Fatalf("unverified sources or redirected author support: %v", splits)
	}
}
