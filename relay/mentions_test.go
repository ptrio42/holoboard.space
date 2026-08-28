package main

import (
	"strings"
	"testing"

	"github.com/nbd-wtf/go-nostr"
)

// A quote note is the obvious way to ask for a promotion: quote the note, tag
// the relay. Most clients put a nostr:nevent1 in the text as well, which the
// content scan catches, but some set only the NIP-18 q tag.
func TestQuotedEventID(t *testing.T) {
	const quoted = "9f1c0d2b3a4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8"

	cases := []struct {
		name string
		tags nostr.Tags
		want string
	}{
		{
			name: "a q tag is the quoted note",
			tags: nostr.Tags{{"p", testRelayPubkey}, {"q", quoted}},
			want: quoted,
		},
		{
			name: "an e tag is not, it is the note being replied to",
			tags: nostr.Tags{{"p", testRelayPubkey}, {"e", quoted}},
			want: "",
		},
		{
			name: "a truncated q tag is ignored",
			tags: nostr.Tags{{"q", "abc"}},
			want: "",
		},
		{
			name: "no tags at all",
			tags: nostr.Tags{},
			want: "",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := quotedEventID(&nostr.Event{Tags: c.tags})
			if got != c.want {
				t.Errorf("quotedEventID = %q, want %q", got, c.want)
			}
		})
	}
}

// The content scan still wins, since that is what nearly every client fills in.
func TestContentReferenceBeatsQuoteTag(t *testing.T) {
	const inText = "note1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"

	found := extractEventIDFromText("promote this " + inText + " thanks")
	if found != inText {
		t.Errorf("content scan returned %q, want the note reference", found)
	}

	// An npub in the same note must not be mistaken for the note reference.
	withMention := extractEventIDFromText(
		"hey nostr:npub1xz73wt7999gs3wfaa923djq3l270hg8v3y0z29j9qgejjyfaweps5xyzav " +
			"please promote nostr:" + inText)
	if withMention != inText {
		t.Errorf("with a mention present the scan returned %q", withMention)
	}
	if strings.HasPrefix(withMention, "npub") {
		t.Error("an npub was read as a note reference")
	}
}
