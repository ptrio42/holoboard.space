package nostr

import (
	"context"
	"crypto/sha256"
	stdjson "encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fasthttp/websocket"
)

func regressionRelay(t *testing.T, handle func(*websocket.Conn)) string {
	t.Helper()
	upgrader := websocket.Upgrader{EnableCompression: true}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		handle(conn)
	}))
	t.Cleanup(server.Close)
	return "ws" + strings.TrimPrefix(server.URL, "http")
}

func regressionAwait(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("connection worker did not stop")
	}
}

func TestHoloboardCloseJoinsConcurrentWritesAndSubscriptions(t *testing.T) {
	stopped := make(chan struct{})
	url := regressionRelay(t, func(conn *websocket.Conn) {
		defer close(stopped)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	relay, err := RelayConnect(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	sub, err := relay.Subscribe(context.Background(), Filter{Kinds: []Kind{1}}, SubscriptionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < 8; i++ {
		workers.Add(2)
		go func() {
			defer workers.Done()
			<-start
			for i := 0; i < 32; i++ {
				if relay.WriteWithError([]byte(`["CLOSE","fixture"]`)) != nil {
					return
				}
			}
		}()
		go func() { defer workers.Done(); <-start; relay.Close() }()
	}
	close(start)
	done := make(chan struct{})
	go func() { workers.Wait(); close(done) }()
	regressionAwait(t, done)
	regressionAwait(t, stopped)
	regressionAwait(t, sub.done)
	if _, open := <-sub.Events; open {
		t.Fatal("subscription remained open")
	}
	if err := relay.WriteWithError([]byte(`["CLOSE","after"]`)); err == nil {
		t.Fatal("closed relay accepted write")
	}
}

func TestHoloboardParentCancellationAndUnconnectedClose(t *testing.T) {
	stopped := make(chan struct{})
	url := regressionRelay(t, func(conn *websocket.Conn) {
		defer close(stopped)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	relay := NewRelay(ctx, url)
	if err := relay.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	cancel()
	relay.Close()
	regressionAwait(t, stopped)
	unconnected := NewRelay(context.Background(), url)
	unconnected.Close()
	unconnected.Close()
	if err := unconnected.WriteWithError([]byte("x")); err == nil {
		t.Fatal("unconnected write accepted")
	}
}

func TestHoloboardSubscriptionBudgetAndWireOrder(t *testing.T) {
	frames := make(chan []stdjson.RawMessage, 256)
	url := regressionRelay(t, func(conn *websocket.Conn) {
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var frame []stdjson.RawMessage
			if stdjson.Unmarshal(data, &frame) == nil {
				frames <- frame
			}
		}
	})
	relay, err := RelayConnect(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	var subs []*Subscription
	for i := 0; i < 8; i++ {
		sub, err := relay.Subscribe(context.Background(), Filter{}, SubscriptionOptions{})
		if err != nil {
			t.Fatal(err)
		}
		subs = append(subs, sub)
	}
	if sub, err := relay.Subscribe(context.Background(), Filter{}, SubscriptionOptions{}); err == nil || sub != nil {
		t.Fatal("subscription cap missing")
	}
	subs[0].Unsub()
	replacement, err := relay.Subscribe(context.Background(), Filter{}, SubscriptionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replacement.Unsub()
	for _, sub := range subs {
		sub.Unsub()
	}
	seen := map[string]bool{}
	for i := 0; i < 18; i++ {
		select {
		case frame := <-frames:
			id := string(frame[1])
			if string(frame[0]) == `"REQ"` {
				seen[id] = true
			} else if !seen[id] {
				t.Fatal("CLOSE overtook REQ")
			}
		case <-time.After(time.Second):
			t.Fatal("missing REQ/CLOSE")
		}
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if sub, err := relay.Subscribe(canceled, Filter{}, SubscriptionOptions{}); err == nil || sub != nil {
		t.Fatal("cancelled request admitted")
	}
	relay.Close()
	select {
	case frame := <-frames:
		t.Fatalf("unexpected cancelled request: %s", frame)
	default:
	}
}

func TestHoloboardQueryPartialEOSEAndClosed(t *testing.T) {
	event := Event{Kind: 1, CreatedAt: 123, Tags: Tags{}, Content: "observed"}
	if err := event.Sign(Generate()); err != nil {
		t.Fatal(err)
	}
	for _, ending := range []string{"timeout", "closed", "eose-closed"} {
		t.Run(ending, func(t *testing.T) {
			url := regressionRelay(t, func(conn *websocket.Conn) {
				_, data, err := conn.ReadMessage()
				if err != nil {
					return
				}
				var frame []stdjson.RawMessage
				stdjson.Unmarshal(data, &frame)
				var id string
				stdjson.Unmarshal(frame[1], &id)
				conn.WriteJSON([]any{"EVENT", id, event})
				if ending == "eose-closed" {
					conn.WriteJSON([]any{"EOSE", id})
				}
				if ending != "timeout" {
					conn.WriteJSON([]any{"CLOSED", id, "fixture refusal"})
				}
				for {
					if _, _, err := conn.ReadMessage(); err != nil {
						return
					}
				}
			})
			relay, err := RelayConnect(context.Background(), url)
			if err != nil {
				t.Fatal(err)
			}
			defer relay.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
			defer cancel()
			found, err := relay.QuerySync(ctx, Filter{IDs: []ID{event.ID}})
			if len(found) != 1 || found[0].ID != event.ID {
				t.Fatalf("observed result lost: %v", err)
			}
			if ending == "timeout" && !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("timeout reported as complete: %v", err)
			}
			if ending == "closed" && err == nil {
				t.Fatal("CLOSED reported as complete")
			}
			if ending == "eose-closed" && err != nil {
				t.Fatalf("actual EOSE lost: %v", err)
			}
		})
	}
}

func TestHoloboardNoSyntheticEOSEAndMultipleFilters(t *testing.T) {
	url := regressionRelay(t, func(conn *websocket.Conn) {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	relay, err := RelayConnect(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	sub, err := relay.Subscribe(ctx, Filter{}, SubscriptionOptions{MaxWaitForEOSE: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Unsub()
	select {
	case <-sub.EndOfStoredEvents:
		t.Fatal("local timer invented EOSE")
	case <-ctx.Done():
	}
	second, err := relay.SubscribeFilters(context.Background(), []Filter{{Kinds: []Kind{1}}, {Kinds: []Kind{4}}})
	if err != nil {
		t.Fatal(err)
	}
	defer second.Unsub()
	if !second.match(Event{Kind: 1}) || !second.match(Event{Kind: 4}) || second.match(Event{Kind: 0}) {
		t.Fatal("multi-filter OR changed")
	}
}

func TestHoloboardDecompressedMessageLimit(t *testing.T) {
	url := regressionRelay(t, func(conn *websocket.Conn) {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
		conn.EnableWriteCompression(true)
		conn.WriteJSON([]any{"UNKNOWN", strings.Repeat("x", (1<<20)+1)})
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	relay, err := RelayConnect(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	sub, err := relay.Subscribe(context.Background(), Filter{}, SubscriptionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Unsub()
	select {
	case <-relay.Context().Done():
	case <-time.After(3 * time.Second):
		t.Fatal("oversized compressed message accepted")
	}
}

func TestHoloboardCanonicalControlEscapes(t *testing.T) {
	for padding := 0; padding < 17; padding++ {
		content := strings.Repeat("x", padding) + "\b\f\n\r\t\"\\<é>\u2028"
		escaped := strings.Repeat("x", padding) + `\b\f\n\r\t\"\\<é>` + "\u2028"
		event := Event{PubKey: KeyOne.Public(), CreatedAt: 123, Kind: 1, Tags: Tags{{"x", content}}, Content: content}
		expected := fmt.Sprintf(`[0,"%s",123,1,[["x","%s"]],"%s"]`, event.PubKey.Hex(), escaped, escaped)
		if got := string(event.Serialize()); got != expected {
			t.Fatalf("serialization differs: %q != %q", got, expected)
		}
		hash := sha256.Sum256([]byte(expected))
		if event.GetID() != ID(hash) {
			t.Fatal("streaming hash differs from canonical bytes")
		}
	}
}

func TestHoloboardRejectsMalformedHexAndOverflowKinds(t *testing.T) {
	for _, value := range []string{`{"kind":65537}`, `{"kind":-1}`, `{"id":"short"}`, `{"sig":"bad"}`, `{"pubkey":"` + strings.Repeat("z", 64) + `"}`} {
		var event Event
		if err := stdjson.Unmarshal([]byte(value), &event); err == nil {
			t.Fatalf("malformed event accepted: %s", value)
		}
	}
	for _, value := range []string{`{"kinds":[65537]}`, `{"ids":["short"]}`, `{"authors":["` + strings.Repeat("z", 64) + `"]}`} {
		var filter Filter
		if err := stdjson.Unmarshal([]byte(value), &filter); err == nil {
			t.Fatalf("malformed filter accepted: %s", value)
		}
	}
}
