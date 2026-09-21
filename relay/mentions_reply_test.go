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

// A public request needs an explicit command. References alone also occur in
// replies, media URLs and ordinary conversation.
func TestPromoteCommandIsWhatMakesItARequest(t *testing.T) {
	silent := []string{
		"anyone tried holoboard?",
		"@holoboard",
		"nostr:npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq is worth a look",
		"look at note1abcdefghijklmnop",
		"https://media.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg",
		"",
	}
	for _, content := range silent {
		if got := mentionedNote(mention(t, content)); got != "" {
			t.Errorf("%.34q read as a request for %q", content, got)
		}
	}

	requests := []string{
		"promote note1notarealreference please",
		"PROMOTE nostr:nevent1qqsanythingatall",
		"please promote: note1abcdefghijklmnop",
	}
	for _, content := range requests {
		if mentionedNote(mention(t, content)) == "" {
			t.Errorf("%.34q read as idle chatter rather than a request", content)
		}
	}
}

// A quote supplies the target only when the author explicitly asks to promote.
func TestPromoteCommandCanTargetAQuote(t *testing.T) {
	id := "1111111111111111111111111111111111111111111111111111111111111111"

	for _, test := range []struct {
		content string
		want    string
	}{
		{content: "@holoboard promote", want: id},
		{content: "this is worth a look", want: ""},
	} {
		evt := &nostr.Event{
			CreatedAt: nostr.Now(), Kind: 1, Content: test.content,
			Tags: nostr.Tags{nostr.Tag{"q", id}},
		}
		if err := evt.Sign(nostr.GeneratePrivateKey()); err != nil {
			t.Fatalf("failed to sign: %v", err)
		}

		if got := mentionedNote(evt); got != test.want {
			t.Errorf("mentionedNote(%q) = %q, want %q", test.content, got, test.want)
		}
	}
}

func TestReplyWithImageHashAndProfileMentionIsNotARequest(t *testing.T) {
	const hash = "a65eeb55c7389044a5eb3f638655b3d3f4bfec8a16fef52313c84c84faaa4377"
	evt := mention(t, "nostr:nprofile1qqsyexample not sure if you yourself promoted your note on holoboard but it looks much nicer now after this update https://media.example/"+hash+".jpg")
	evt.Tags = nostr.Tags{
		{"e", "cbd91bb5566fd2f701f1a90f3597ada810abb2ae58c3d2942b6ef66da5aeaf8e", "", "root"},
		{"p", testRelayPubkey},
	}

	if got := mentionedNote(evt); got != "" {
		t.Errorf("ordinary reply was read as a promotion request for %q", got)
	}

	monitor, storage := mentionFixture(t)
	if err := monitor.ProcessMention(context.Background(), evt); err != nil {
		t.Fatalf("ordinary reply produced an error instead of silence: %v", err)
	}
	if !storage.IsMentionProcessed(evt.ID) {
		t.Error("ordinary reply was not marked as processed")
	}
}
