package main

import (
	"context"
	"testing"
	"time"

	"fiatjaf.com/nostr"
)

func TestPromotionZapRetainsOriginalSource(t *testing.T) {
	for _, path := range []string{"outbox-restart", "legacy-reference-restart", "legacy-id-reconstruction", "signed-reply", "signed-quote", "signed-content-hints", "signed-parent-hints"} {
		t.Run(path, func(t *testing.T) {
			boardRelay, sourceRelay := startTestRelay(t), startTestRelay(t)
			storage, publisher, note := accountPublicationFixture(t, boardRelay)
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			source, err := nostr.RelayConnect(ctx, sourceRelay)
			if err != nil {
				t.Fatal(err)
			}
			defer source.Close()
			if err := source.Publish(ctx, *note); err != nil {
				t.Fatal(err)
			}
			reference, err := encodeEventReference(note.ID.Hex(), []string{sourceRelay}, note.PubKey.Hex())
			if err != nil {
				t.Fatal(err)
			}
			request := mention(t, "promote nostr:"+reference)
			fetcher := NewPostFetcher([]string{boardRelay})
			mentions := NewMentionMonitor(publisher.relayPubkey, publisher.relayPrivkey, storage, fetcher)
			mentions.SetAccountPublisher(publisher)
			if err := mentions.ProcessMention(ctx, request); err != nil {
				t.Fatal(err)
			}
			jobs := storage.PendingAccountPublications()
			if len(jobs) != 1 {
				t.Fatalf("queued replies = %d", len(jobs))
			}
			reply := jobs[0].Record.Event
			if path == "signed-quote" {
				reply, err = publisher.BuildQuote(note, sourceRelay)
				if err != nil {
					t.Fatal(err)
				}
			}
			if path == "signed-content-hints" || path == "signed-parent-hints" {
				for i, tag := range reply.Tags {
					if tag[0] == "q" {
						reply.Tags[i] = nostr.Tag{"q", note.ID.Hex()}
					}
				}
				if path == "signed-parent-hints" {
					reply.Content = promotionalReplyCopy
				}
				if err := signEvent(reply, publisher.relayPrivkey); err != nil {
					t.Fatal(err)
				}
			}
			if path != "outbox-restart" {
				storage = newTestStorage(t)
				if path == "legacy-reference-restart" || path == "legacy-id-reconstruction" {
					target := reference
					if path == "legacy-id-reconstruction" {
						target = note.ID.Hex()
					}
					if err := storage.AddPromotionalReply(reply.ID.Hex(), target); err != nil {
						t.Fatal(err)
					}
				}
			}
			storage, err = NewStorage(storage.dataFile)
			if err != nil {
				t.Fatal(err)
			}
			monitor := NewPaymentMonitor(storage, publisher.relayPubkey, fetcher, nil)
			if path == "outbox-restart" || path == "legacy-reference-restart" {
				id, hints, author, ok := storage.GetPromotedNoteReference(reply.ID.Hex())
				if !ok || id != note.ID.Hex() || len(hints) != 1 || hints[0] != sourceRelay || author != note.PubKey.Hex() {
					t.Fatalf("restored reference: %s %v %s %v", id, hints, author, ok)
				}
				// The stored mapping must work even if the reply is unavailable.
			} else {
				board, err := nostr.RelayConnect(ctx, boardRelay)
				if err != nil {
					t.Fatal(err)
				}
				defer board.Close()
				if path == "signed-parent-hints" {
					if err := board.Publish(ctx, *request); err != nil {
						t.Fatal(err)
					}
				}
				if err := board.Publish(ctx, *reply); err != nil {
					t.Fatal(err)
				}
				id, hints, author, err := monitor.getPromotedNoteFromChain(reply.ID.Hex())
				if err != nil || id != note.ID.Hex() || len(hints) != 1 || hints[0] != sourceRelay || author != note.PubKey.Hex() {
					t.Fatalf("signed reference: %s %v %s %v", id, hints, author, err)
				}
			}
			provider := generatePrivateKey()
			providerPubkey, _ := publicKeyForSecret(provider)
			monitor.zapValidator = seedResolver(providerPubkey)
			receipt := mintZapReceipt(t, provider, 21000, nostr.Tags{{"p", publisher.relayPubkey}, {"e", reply.ID.Hex()}, {"amount", "21000"}})
			receipt.Tags[0][1] = publisher.relayPubkey
			if err := signEvent(receipt, provider); err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 2; i++ {
				if err := monitor.ProcessZap(ctx, receipt); err != nil {
					t.Fatalf("paid promotion rejected: %v", err)
				}
			}
			post, ok := storage.GetPost(note.ID.Hex())
			if !ok || post.TotalSatsPaid != 21 {
				t.Fatalf("promotion = %+v; want 21 sats exactly once", post)
			}
		})
	}
}

func TestLegacyPromotionalReplyPersistsSourceReference(t *testing.T) {
	relay := startTestRelay(t)
	storage, publisher, note := accountPublicationFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	mentions := NewMentionMonitor(publisher.relayPubkey, publisher.relayPrivkey, storage, NewPostFetcher([]string{relay}))
	request := mention(t, "promote "+note.ID.Hex())
	if err := mentions.CreatePromotionalReply(ctx, request, note, "wss://original.example"); err != nil {
		t.Fatal(err)
	}
	loaded, err := NewStorage(storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.promotionalReplies) != 1 {
		t.Fatal("legacy flow lost its reply mapping")
	}
	for replyID := range loaded.promotionalReplies {
		id, hints, author, ok := loaded.GetPromotedNoteReference(replyID)
		if !ok || id != note.ID.Hex() || len(hints) != 1 || hints[0] != "wss://original.example" || author != note.PubKey.Hex() {
			t.Fatalf("legacy source: %s %v %s %v", id, hints, author, ok)
		}
	}
}

func TestPromotionChainRejectsForeignSignedQuote(t *testing.T) {
	relay := startTestRelay(t)
	storage, publisher, note := accountPublicationFixture(t)
	quote, err := publisher.BuildQuote(note, relay)
	if err != nil {
		t.Fatal(err)
	}
	if err := signEvent(quote, generatePrivateKey()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection, err := nostr.RelayConnect(ctx, relay)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := connection.Publish(ctx, *quote); err != nil {
		t.Fatal(err)
	}
	monitor := NewPaymentMonitor(storage, publisher.relayPubkey, NewPostFetcher([]string{relay}), nil)
	if _, _, _, err := monitor.getPromotedNoteFromChain(quote.ID.Hex()); err == nil {
		t.Fatal("accepted a foreign payment target")
	}
}
