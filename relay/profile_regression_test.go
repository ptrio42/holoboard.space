package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"fiatjaf.com/nostr"
	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsutil"
)

func TestRecipientProfileComparesAuthorWriteRelays(t *testing.T) {
	previous := discoveryRelays
	discoveryRelays = nil
	t.Cleanup(func() { discoveryRelays = previous })
	for _, test := range []struct {
		name, cached, current string
		unavailable           bool
		want                  int
	}{
		{"new address supersedes an empty cache", `{}`, `{"lud16":"author@wallet.example"}`, false, 20},
		{"new removal supersedes an old address", `{"lud16":"old@wallet.example"}`, `{}`, false, 0},
		{"unreachable write relay cannot confirm an old absence", `{}`, "", true, 20},
	} {
		t.Run(test.name, func(t *testing.T) {
			noteRelay, writeRelay := startTestRelay(t), startTestRelay(t)
			if test.unavailable {
				failure := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
				t.Cleanup(failure.Close)
				writeRelay = "ws" + strings.TrimPrefix(failure.URL, "http")
			}
			storage, publisher, note := accountPublicationFixture(t, noteRelay)
			key := generatePrivateKey()
			if err := signEvent(note, key); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			now := nostr.Now()
			var latest *nostr.Event
			fixtures := []struct {
				source  string
				kind    int
				at      nostr.Timestamp
				content string
				tags    nostr.Tags
			}{
				{noteRelay, 0, now - 100, test.cached, nostr.Tags{}},
				{noteRelay, kindRelayList, now, "", nostr.Tags{{"r", writeRelay, "write"}}},
			}
			if !test.unavailable {
				fixtures = append(fixtures, struct {
					source  string
					kind    int
					at      nostr.Timestamp
					content string
					tags    nostr.Tags
				}{writeRelay, 0, now, test.current, nostr.Tags{}})
			}
			for _, fixture := range fixtures {
				event := &nostr.Event{Kind: nostr.Kind(fixture.kind), CreatedAt: fixture.at, Content: fixture.content, Tags: fixture.tags}
				if err := signEvent(event, key); err != nil {
					t.Fatal(err)
				}
				connection, err := nostr.RelayConnect(ctx, fixture.source)
				if err != nil {
					t.Fatal(err)
				}
				err = connection.Publish(ctx, *event)
				connection.Close()
				if err != nil {
					t.Fatal(err)
				}
				if fixture.source == writeRelay {
					latest = event
				}
			}
			profile, source := findRecipientProfile(ctx, note.PubKey.Hex(), []string{noteRelay})
			if test.unavailable {
				if profile != nil || source != "" {
					t.Fatal("old empty profile established absence despite unavailable write relay")
				}
			} else if profile == nil || profile.ID.Hex() != latest.ID.Hex() || source != writeRelay {
				t.Fatalf("selected stale profile: %+v on %q; expected %s on %q", profile, source, latest.ID.Hex(), writeRelay)
			}
			support := NewAuthorSupport(storage, NewPostFetcher([]string{noteRelay}))
			if share := support.campaignShare(ctx, note, 20, nil); share != test.want {
				t.Fatalf("campaign share %d, want %d", share, test.want)
			}
			support.client.Transport = supportTransport(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"tag":"payRequest","callback":"https://wallet.example/callback","metadata":"[[\"text/plain\",\"Author support\"]]","minSendable":1000,"maxSendable":1000000}`)), Header: make(http.Header)}, nil
			})
			_, endpointError := support.endpoint(ctx, note.PubKey.Hex())
			if test.want == 0 && endpointError != errAuthorHasNoAddress {
				t.Fatalf("new removal not identified: %v", endpointError)
			}
			if test.unavailable && (endpointError == nil || endpointError == errAuthorHasNoAddress) {
				t.Fatalf("unavailable profile reported as missing address: %v", endpointError)
			}
			if !test.unavailable && test.want > 0 && endpointError != nil {
				t.Fatalf("new payment address not available: %v", endpointError)
			}
			publisher.profile = findRecipientProfile
			quote, err := publisher.BuildQuoteWithSplit(note, noteRelay, 20)
			if err != nil {
				t.Fatal(err)
			}
			if share := *quoteAuthorShare(quote); share != test.want {
				t.Fatalf("quote share %d, want %d: %v", share, test.want, quote.Tags)
			}
			if test.want > 0 && !test.unavailable {
				splits := collectTags(quote.Tags, "zap")
				if len(splits) != 2 || splits[1][2] != writeRelay {
					t.Fatalf("quote has a stale author profile hint: %v", splits)
				}
			}
		})
	}
}

func TestRecipientProfileUsesDiscoveryWithoutRelayList(t *testing.T) {
	index := startTestRelay(t)
	previous := discoveryRelays
	discoveryRelays = []string{index}
	t.Cleanup(func() { discoveryRelays = previous })
	key := generatePrivateKey()
	profile := &nostr.Event{Kind: 0, CreatedAt: nostr.Now(), Tags: nostr.Tags{}, Content: `{"lud16":"author@wallet.example"}`}
	if err := signEvent(profile, key); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection, err := nostr.RelayConnect(ctx, index)
	if err != nil {
		t.Fatal(err)
	}
	err = connection.Publish(ctx, *profile)
	connection.Close()
	if err != nil {
		t.Fatal(err)
	}
	selected, source := findRecipientProfile(ctx, profile.PubKey.Hex(), nil)
	if selected == nil || selected.ID.Hex() != profile.ID.Hex() || source != index {
		t.Fatalf("discovery profile not found without a relay list: %+v, %q", selected, source)
	}
}

func TestRecipientProfileUnavailableRelaysRespectDeadline(t *testing.T) {
	previous := discoveryRelays
	discoveryRelays = nil
	t.Cleanup(func() { discoveryRelays = previous })
	closed := make(chan struct{}, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, _, _, err := ws.UpgradeHTTP(r, w)
		if err != nil {
			return
		}
		defer conn.Close()
		defer func() { closed <- struct{}{} }()
		for {
			if _, _, err := wsutil.ReadClientData(conn); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	started := time.Now()
	key, _ := publicKeyForSecret(generatePrivateKey())
	sourceRelay := "ws" + strings.TrimPrefix(server.URL, "http")
	trustConfiguredRelays([]string{sourceRelay})
	profile, source := findRecipientProfile(ctx, key, []string{sourceRelay})
	if profile != nil || source != "" {
		t.Fatal("unresponsive relays established an address or its absence")
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("profile search exceeded its context deadline: %v", elapsed)
	}
	for i := 0; i < 2; i++ {
		select {
		case <-closed:
		case <-time.After(2 * time.Second):
			t.Fatal("profile lookup left a socket open")
		}
	}
}

func TestReplaceableProfilesUseNIP01TieBreak(t *testing.T) {
	for _, test := range []struct {
		candidate, current *nostr.Event
		want               bool
	}{
		{nil, nil, false},
		{&nostr.Event{CreatedAt: 2, ID: nostr.MustIDFromHex(strings.Repeat("b", 64))}, nil, true},
		{&nostr.Event{CreatedAt: 2, ID: nostr.MustIDFromHex(strings.Repeat("b", 64))}, &nostr.Event{CreatedAt: 1, ID: nostr.MustIDFromHex(strings.Repeat("a", 64))}, true},
		{&nostr.Event{CreatedAt: 1, ID: nostr.MustIDFromHex(strings.Repeat("a", 64))}, &nostr.Event{CreatedAt: 2, ID: nostr.MustIDFromHex(strings.Repeat("b", 64))}, false},
		{&nostr.Event{CreatedAt: 2, ID: nostr.MustIDFromHex(strings.Repeat("a", 64))}, &nostr.Event{CreatedAt: 2, ID: nostr.MustIDFromHex(strings.Repeat("b", 64))}, true},
		{&nostr.Event{CreatedAt: 2, ID: nostr.MustIDFromHex(strings.Repeat("b", 64))}, &nostr.Event{CreatedAt: 2, ID: nostr.MustIDFromHex(strings.Repeat("a", 64))}, false},
	} {
		if got := newerReplaceableEvent(test.candidate, test.current); got != test.want {
			t.Fatalf("tie break: %+v", test)
		}
	}
}
