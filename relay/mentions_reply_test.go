package main

import (
	"context"
	"testing"

	"github.com/nbd-wtf/go-nostr"
)

// mentionFixture wires a monitor with no relays, so any attempt to reply fails
// to publish rather than reaching the network. What is under test is whether a
// reply is attempted at all.
func mentionFixture(t *testing.T) (*MentionMonitor, *Storage) {
	t.Helper()

	storage := newTestStorage(t)
	privkey := nostr.GeneratePrivateKey()
	pubkey, _ := nostr.GetPublicKey(privkey)

	return NewMentionMonitor(pubkey, privkey, storage, NewPostFetcher(nil), nostr.NewSimplePool(context.Background())), storage
}

func mention(t *testing.T, content string) *nostr.Event {
	t.Helper()

	evt := &nostr.Event{CreatedAt: nostr.Now(), Kind: 1, Tags: nostr.Tags{}, Content: content}
	if err := evt.Sign(nostr.GeneratePrivateKey()); err != nil {
		t.Fatalf("failed to sign: %v", err)
	}
	return evt
}

// Naming the board in a note is talking about it, not to it. Answering those
// turned the account into something that interrupts people mid-conversation.
func TestMentionWithoutANoteGetsNoReply(t *testing.T) {
	monitor, storage := mentionFixture(t)

	for _, content := range []string{
		"nostr:npub1... has been good lately",
		"anyone tried holoboard?",
		"@holoboard",
		"",
	} {
		event := mention(t, content)
		if err := monitor.ProcessMention(context.Background(), event); err != nil {
			t.Errorf("%.30q produced an error instead of silence: %v", content, err)
		}
		// Marked, so it is not reconsidered on the next pass.
		if !storage.IsMentionProcessed(event.ID) {
			t.Errorf("%.30q was left unprocessed and will come round again", content)
		}
	}
}

// Somebody who did include a reference and got it wrong is trying to use the
// thing, so that still counts as a request and still gets an answer. The line
// between the two cases is the whole of the policy.
func TestAReferenceIsWhatMakesItARequest(t *testing.T) {
	silent := []string{
		"anyone tried holoboard?",
		"@holoboard",
		"nostr:npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq is worth a look",
		"",
	}
	for _, content := range silent {
		if got := mentionedNote(mention(t, content)); got != "" {
			t.Errorf("%.34q read as a request for %q", content, got)
		}
	}

	requests := []string{
		"promote note1notarealreference please",
		"nostr:nevent1qqsanythingatall",
		"put note1abcdefghijklmnop up",
	}
	for _, content := range requests {
		if mentionedNote(mention(t, content)) == "" {
			t.Errorf("%.34q read as idle chatter rather than a request", content)
		}
	}
}

// A quote counts as pointing at a note even when the text says nothing.
func TestAQuoteCountsAsAReference(t *testing.T) {
	id := "1111111111111111111111111111111111111111111111111111111111111111"

	evt := &nostr.Event{
		CreatedAt: nostr.Now(), Kind: 1, Content: "worth a look",
		Tags: nostr.Tags{nostr.Tag{"q", id}},
	}
	if err := evt.Sign(nostr.GeneratePrivateKey()); err != nil {
		t.Fatalf("failed to sign: %v", err)
	}

	if got := mentionedNote(evt); got != id {
		t.Errorf("quote tag gave %q, want the quoted id", got)
	}
}
