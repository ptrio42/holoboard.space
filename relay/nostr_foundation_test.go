package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsutil"
	"github.com/nbd-wtf/go-nostr"
)

func fixtureWireRelay(t *testing.T, event *nostr.Event, eose bool) (string, <-chan struct{}) {
	t.Helper()
	closed := make(chan struct{}, 8)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, _, _, err := ws.UpgradeHTTP(r, w)
		if err != nil {
			return
		}
		defer conn.Close()
		defer func() { closed <- struct{}{} }()
		for {
			data, _, err := wsutil.ReadClientData(conn)
			if err != nil {
				return
			}
			var frame []json.RawMessage
			if json.Unmarshal(data, &frame) != nil || len(frame) < 2 || string(frame[0]) != `"REQ"` {
				continue
			}
			var id string
			json.Unmarshal(frame[1], &id)
			if event != nil {
				message, _ := json.Marshal([]any{"EVENT", id, event})
				wsutil.WriteServerText(conn, message)
			}
			if eose {
				message, _ := json.Marshal([]any{"EOSE", id})
				wsutil.WriteServerText(conn, message)
			}
		}
	}))
	t.Cleanup(server.Close)
	return "ws" + strings.TrimPrefix(server.URL, "http"), closed
}

func TestExactIDFetchDoesNotWaitForEOSE(t *testing.T) {
	note := &nostr.Event{Kind: 1, CreatedAt: nostr.Now(), Tags: nostr.Tags{}, Content: "available without EOSE"}
	if err := note.Sign(nostr.GeneratePrivateKey()); err != nil {
		t.Fatal(err)
	}
	source, closed := fixtureWireRelay(t, note, false)
	fetcher := NewPostFetcher([]string{source})
	ctx, cancel := context.WithTimeout(context.Background(), 700*time.Millisecond)
	defer cancel()
	start := time.Now()
	found, _, err := fetcher.FetchPostFromWithRelay(ctx, note.ID, nil, "")
	if err != nil || found == nil || found.ID != note.ID {
		t.Fatalf("available event lost: %v", err)
	}
	if time.Since(start) > 500*time.Millisecond {
		t.Fatal("exact ID lookup waited for EOSE")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("successful lookup left a socket open")
	}
}

func TestForgedIDCannotEnterPostFetcher(t *testing.T) {
	note := &nostr.Event{Kind: 1, CreatedAt: nostr.Now(), Tags: nostr.Tags{}, Content: "signed but ID replaced"}
	note.Sign(nostr.GeneratePrivateKey())
	note.ID = strings.Repeat("f", 64)
	source, _ := fixtureWireRelay(t, note, true)
	fetcher := NewPostFetcher([]string{source})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	found, err := fetcher.FetchPost(ctx, note.ID)
	if found != nil || !errors.Is(err, errNoteNotFound) {
		t.Fatalf("forged ID accepted or absence misclassified: %v", err)
	}
}

func TestExternalLocalHintsCannotDial(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1); w.WriteHeader(503) }))
	defer server.Close()
	fetcher := NewPostFetcher(nil)
	_, err := fetcher.FetchPostFrom(context.Background(), strings.Repeat("a", 64), []string{"ws" + strings.TrimPrefix(server.URL, "http")}, "")
	if err == nil || requests.Load() != 0 {
		t.Fatal("untrusted hint reached a private endpoint")
	}
}

func TestDNSPinRejectsMixedAndPrivateAnswers(t *testing.T) {
	for _, answers := range [][]netip.Addr{
		{netip.MustParseAddr("127.0.0.1")},
		{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("10.0.0.1")},
		{netip.MustParseAddr("::ffff:169.254.169.254")},
	} {
		conn, err := dialRelayAddress(context.Background(), "tcp", "public.example.com:443", false, func(context.Context, string, string) ([]netip.Addr, error) { return answers, nil })
		if conn != nil || err == nil {
			t.Fatal("non-public DNS answer was accepted")
		}
	}
	for _, address := range []string{"0.0.0.0", "100.64.0.1", "198.18.0.1", "192.0.2.1", "::1", "fc00::1", "2001:db8::1", "64:ff9b::7f00:1"} {
		if publicRelayIP(netip.MustParseAddr(address)) {
			t.Fatalf("special-purpose IP accepted: %s", address)
		}
	}
}

func TestQuerySyncPreservesObservedProfileOnTimeout(t *testing.T) {
	profile := &nostr.Event{Kind: 0, CreatedAt: nostr.Now(), Tags: nostr.Tags{}, Content: `{"name":"partial"}`}
	profile.Sign(nostr.GeneratePrivateKey())
	source, closed := fixtureWireRelay(t, profile, false)
	trustConfiguredRelays([]string{source})
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	found, _ := queryRecipientProfile(ctx, profile.PubKey, []string{source})
	if found == nil || found.ID != profile.ID {
		t.Fatal("observed profile discarded without EOSE")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("timed-out lookup left a socket open")
	}
}

func TestZapMonitorReconnectsAndStopsAfterRelayDrop(t *testing.T) {
	connections := make(chan struct{}, 8)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, _, _, err := ws.UpgradeHTTP(r, w)
		if err != nil {
			return
		}
		defer conn.Close()
		if _, _, err := wsutil.ReadClientData(conn); err == nil {
			connections <- struct{}{}
		}
	}))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http")
	monitor := NewZapMonitor([]string{url}, strings.Repeat("a", 64), nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	monitor.Start(ctx)
	for i := 0; i < 2; i++ {
		select {
		case <-connections:
		case <-time.After(3 * time.Second):
			t.Fatal("monitor did not reconnect")
		}
	}
	cancel()
	done := make(chan struct{})
	go func() { monitor.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("monitor did not stop during backoff")
	}
}

func TestPublicationRoutesAreDurableBeforeDeliveryAndDeletion(t *testing.T) {
	storage, publisher, note := accountPublicationFixture(t, "wss://own.example.com")
	quote, err := publisher.BuildQuote(note, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.CreditZapWithPublication(note.ID, 21, note, "zap-route", "hash-route", quote, publisher.Targets()); err != nil {
		t.Fatal(err)
	}
	publisher.readRelays = func(context.Context, string, []string) []string { return []string{"wss://recipient.example.com"} }
	publisher.publish = func(ctx context.Context, url string, event *nostr.Event) error {
		snapshot, _ := storage.QuotePublication(note.ID)
		if !containsString(snapshot.Targets, "wss://recipient.example.com") {
			t.Error("EVENT sent before routing was saved")
		}
		if event.ID != quote.ID {
			t.Error("routing changed signed event identity")
		}
		return nil
	}
	publisher.publishPending(context.Background())
	if _, err := publisher.RemovePost(note.ID); err != nil {
		t.Fatal(err)
	}
	for _, job := range storage.PendingAccountPublications() {
		if job.Record.Event.Kind == 5 && !containsString(job.Record.Targets, "wss://recipient.example.com") {
			t.Fatal("deletion omitted a quote destination")
		}
	}
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func TestMonitorBackfillPaginatesBeyondTheInitialWindow(t *testing.T) {
	key := nostr.GeneratePrivateKey()
	var events []*nostr.Event
	now := nostr.Now()
	for i := 0; i < 150; i++ {
		event := &nostr.Event{Kind: 1, CreatedAt: now - nostr.Timestamp(i), Tags: nostr.Tags{}, Content: "backfill"}
		if err := event.Sign(key); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, _, _, err := ws.UpgradeHTTP(r, w)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			message, _, err := wsutil.ReadClientData(conn)
			if err != nil {
				return
			}
			var frame []json.RawMessage
			if json.Unmarshal(message, &frame) != nil || len(frame) < 3 || string(frame[0]) != `"REQ"` {
				continue
			}
			var id string
			var filter nostr.Filter
			json.Unmarshal(frame[1], &id)
			json.Unmarshal(frame[2], &filter)
			sent := 0
			for _, event := range events {
				if !filter.Matches(event) {
					continue
				}
				if sent >= filter.Limit {
					break
				}
				data, _ := json.Marshal([]any{"EVENT", id, event})
				if wsutil.WriteServerText(conn, data) != nil {
					return
				}
				sent++
			}
			data, _ := json.Marshal([]any{"EOSE", id})
			wsutil.WriteServerText(conn, data)
		}
	}))
	defer server.Close()
	source := "ws" + strings.TrimPrefix(server.URL, "http")
	trustConfiguredRelays([]string{source})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	relay, err := connectRelay(ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	seen := map[string]bool{}
	backfillRelay(ctx, relay, nostr.Filter{Kinds: []int{1}}, func(_ context.Context, event *nostr.Event) error { seen[event.ID] = true; return nil })
	if len(seen) != 150 {
		t.Fatalf("backfill returned %d events, want 150", len(seen))
	}
}
