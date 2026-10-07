package khatru

import (
	"context"
	"encoding/json"
	"iter"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"fiatjaf.com/nostr"
	"github.com/fasthttp/websocket"
)

func localRelay(t *testing.T, relay *Relay) *websocket.Conn {
	t.Helper()
	server := httptest.NewServer(relay)
	t.Cleanup(server.Close)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(); relay.Shutdown(context.Background()) })
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	return conn
}

func TestHoloboardLiveIDFilterAndConcurrentListeners(t *testing.T) {
	relay := NewRelay()
	conn := localRelay(t, relay)
	wanted := nostr.Event{Kind: 1, Tags: nostr.Tags{}, Content: "wanted"}
	wanted.Sign(nostr.Generate())
	wrong := nostr.Event{Kind: 1, Tags: nostr.Tags{}, Content: "wrong"}
	wrong.Sign(nostr.Generate())
	conn.WriteJSON([]any{"REQ", "exact", nostr.Filter{IDs: []nostr.ID{wanted.ID}}})
	var eose []json.RawMessage
	if err := conn.ReadJSON(&eose); err != nil {
		t.Fatal(err)
	}
	if string(eose[0]) != `"EOSE"` {
		t.Fatal("missing EOSE")
	}
	var workers sync.WaitGroup
	workers.Add(1)
	go func() {
		defer workers.Done()
		for i := 0; i < 100; i++ {
			relay.GetListeningFilters()
			relay.BroadcastEvent(wrong)
		}
	}()
	if relay.BroadcastEvent(wanted) != 1 {
		t.Fatal("exact ID subscriber missed live event")
	}
	workers.Wait()
	var frame []json.RawMessage
	if err := conn.ReadJSON(&frame); err != nil {
		t.Fatal(err)
	}
	var received nostr.Event
	if len(frame) != 3 || json.Unmarshal(frame[2], &received) != nil || received.ID != wanted.ID {
		t.Fatalf("wrong event delivered: %s", frame)
	}
	conn.WriteJSON([]any{"CLOSE", "exact"})
	conn.WriteJSON([]any{"REQ", "barrier", nostr.Filter{LimitZero: true}})
	if err := conn.ReadJSON(&frame); err != nil {
		t.Fatal(err)
	}
	if relay.BroadcastEvent(wanted) != 1 {
		t.Fatal("wire-ordered CLOSE left an extra listener")
	}
}

func TestHoloboardCloseCancelsStoredQuery(t *testing.T) {
	relay := NewRelay()
	entered, stopped := make(chan struct{}), make(chan struct{})
	relay.QueryStored = func(ctx context.Context, _ nostr.Filter) iter.Seq[nostr.Event] {
		return func(yield func(nostr.Event) bool) { close(entered); <-ctx.Done(); close(stopped) }
	}
	conn := localRelay(t, relay)
	conn.WriteJSON([]any{"REQ", "slow", nostr.Filter{Kinds: []nostr.Kind{1}}})
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("query did not start")
	}
	conn.WriteJSON([]any{"CLOSE", "slow"})
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("CLOSE did not cancel query")
	}
}

func TestHoloboardInboundFilterBudgetAndForgedID(t *testing.T) {
	relay := NewRelay()
	var admitted atomic.Int32
	relay.OnEvent = func(context.Context, nostr.Event) (bool, string) { admitted.Add(1); return false, "" }
	conn := localRelay(t, relay)
	filters := make([]any, 0, 11)
	filters = append(filters, "REQ", "over")
	for i := 0; i < 9; i++ {
		filters = append(filters, nostr.Filter{})
	}
	conn.WriteJSON(filters)
	var frame []json.RawMessage
	if err := conn.ReadJSON(&frame); err != nil {
		t.Fatal(err)
	}
	if string(frame[0]) != `"CLOSED"` || len(relay.GetListeningFilters()) != 0 {
		t.Fatal("oversized REQ admitted")
	}
	event := nostr.Event{Kind: 1, Tags: nostr.Tags{}, Content: "signed"}
	event.Sign(nostr.Generate())
	event.ID = nostr.MustIDFromHex(strings.Repeat("f", 64))
	conn.WriteJSON([]any{"EVENT", event})
	if err := conn.ReadJSON(&frame); err != nil {
		t.Fatal(err)
	}
	if string(frame[0]) != `"OK"` || string(frame[2]) != "false" || admitted.Load() != 0 {
		t.Fatal("forged ID reached application")
	}
}
