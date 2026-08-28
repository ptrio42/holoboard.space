package main

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/nbd-wtf/go-nostr"
)

// newTestMonitor builds a PaymentMonitor backed by a throwaway data file and a
// fetcher with no relays, so nothing in these tests touches the network.
// fetchEvent bails out on the empty relay list before it opens a connection.
func newTestMonitor(t *testing.T, relayPubkey string) *PaymentMonitor {
	t.Helper()

	storage, err := NewStorage(filepath.Join(t.TempDir(), "relay_data.json"))
	if err != nil {
		t.Fatalf("failed to create storage: %v", err)
	}

	return NewPaymentMonitor(storage, relayPubkey, NewPostFetcher(nil), NewLNURLResolver())
}

// TestProcessZapSurvivesShortEventID covers the crash that a forged zap used to
// cause. The 'e' tag of a zap request is read out of the receipt's description
// tag, which nobody signs, so its value can be any length at all. Abbreviating
// it for a log line used to slice it to 8 bytes unconditionally, and ProcessZap
// runs on goroutines that have no recover(), so one crafted event published to
// any monitored relay killed the process.
func TestProcessZapSurvivesShortEventID(t *testing.T) {
	const relayPubkey = "30bd172fc5295108b93de95516c811fabcfba0ec891e251645023329113d7643"

	shortIDs := []string{"x", "", "abc", "1234567"}

	for _, id := range shortIDs {
		t.Run("e_tag_"+id, func(t *testing.T) {
			pm := newTestMonitor(t, relayPubkey)

			zapRequest := `{"kind":9734,"tags":[["e","` + id + `"]],"content":""}`
			zap := &nostr.Event{
				ID:   "aa" + id + "deadbeef",
				Kind: 9735,
				Tags: nostr.Tags{
					{"p", relayPubkey},
					{"bolt11", "lnbc10u1..."},
					{"description", zapRequest},
				},
			}

			// The zap carries no resolvable post, so an error is the right
			// outcome. What matters is that we get an error rather than a panic.
			if err := pm.ProcessZap(context.Background(), zap); err == nil {
				t.Fatal("expected an error for a zap with no resolvable post ID, got nil")
			}
		})
	}
}

// TestProcessZapSurvivesShortCommentID covers the same class of bug on the
// other branches that derive a post ID from untrusted text rather than from
// the 'e' tag.
func TestProcessZapSurvivesShortCommentID(t *testing.T) {
	const relayPubkey = "30bd172fc5295108b93de95516c811fabcfba0ec891e251645023329113d7643"

	pm := newTestMonitor(t, relayPubkey)

	zapRequest := `{"kind":9734,"tags":[],"content":"promote note1short"}`
	zap := &nostr.Event{
		ID:   "bb00deadbeef",
		Kind: 9735,
		Tags: nostr.Tags{
			{"p", relayPubkey},
			{"bolt11", "lnbc10u1..."},
			{"description", zapRequest},
		},
	}

	if err := pm.ProcessZap(context.Background(), zap); err == nil {
		t.Fatal("expected an error for an unresolvable post reference, got nil")
	}
}

// TestShortNeverPanics pins the helper itself, since every call site above
// depends on it tolerating inputs shorter than the requested bound.
func TestShortNeverPanics(t *testing.T) {
	cases := []struct {
		in   string
		n    int
		want string
	}{
		{"", 8, ""},
		{"abc", 8, "abc"},
		{"abcdefgh", 8, "abcdefgh"},
		{"abcdefghij", 8, "abcdefgh"},
		{"abc", 0, ""},
	}

	for _, c := range cases {
		if got := short(c.in, c.n); got != c.want {
			t.Errorf("short(%q, %d) = %q, want %q", c.in, c.n, got, c.want)
		}
	}
}
