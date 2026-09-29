package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsutil"
	"github.com/nbd-wtf/go-nostr"
)

func readMentionRequest(w http.ResponseWriter, r *http.Request) (net.Conn, *bufio.ReadWriter, string, nostr.Filter, error) {
	conn, buffered, _, err := ws.UpgradeHTTP(r, w)
	if err != nil {
		return nil, nil, "", nostr.Filter{}, err
	}
	frames, err := wsutil.ReadClientMessage(buffered.Reader, nil)
	if err != nil {
		conn.Close()
		return nil, nil, "", nostr.Filter{}, fmt.Errorf("read REQ: %w", err)
	}
	if len(frames) == 0 {
		conn.Close()
		return nil, nil, "", nostr.Filter{}, fmt.Errorf("empty REQ")
	}

	var request []json.RawMessage
	if err := json.Unmarshal(frames[0].Payload, &request); err != nil {
		conn.Close()
		return nil, nil, "", nostr.Filter{}, fmt.Errorf("decode REQ: %w", err)
	}
	if len(request) < 3 {
		conn.Close()
		return nil, nil, "", nostr.Filter{}, fmt.Errorf("REQ has %d fields", len(request))
	}
	var command, id string
	var filter nostr.Filter
	if err := json.Unmarshal(request[0], &command); err != nil {
		conn.Close()
		return nil, nil, "", nostr.Filter{}, err
	}
	if err := json.Unmarshal(request[1], &id); err != nil {
		conn.Close()
		return nil, nil, "", nostr.Filter{}, err
	}
	if err := json.Unmarshal(request[2], &filter); err != nil {
		conn.Close()
		return nil, nil, "", nostr.Filter{}, err
	}
	if command != "REQ" {
		conn.Close()
		return nil, nil, "", nostr.Filter{}, fmt.Errorf("got %q, want REQ", command)
	}
	return conn, buffered, id, filter, nil
}

func sendMentionEnvelope(conn net.Conn, fields ...any) error {
	message, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	return wsutil.WriteServerMessage(conn, ws.OpText, message)
}

func waitForMention(t *testing.T, storage *Storage, id string) {
	t.Helper()
	deadline := time.After(7 * time.Second)
	for !storage.IsMentionProcessed(id) {
		select {
		case <-deadline:
			t.Fatalf("mention %s was not processed", short(id, 8))
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func signedTestMention(t *testing.T, pubkey string, createdAt nostr.Timestamp) *nostr.Event {
	t.Helper()
	event := &nostr.Event{
		CreatedAt: createdAt,
		Kind:      1,
		Tags:      nostr.Tags{{"p", pubkey}},
		Content:   "A regular mention without a promotion command.",
	}
	if err := event.Sign(nostr.GeneratePrivateKey()); err != nil {
		t.Fatal(err)
	}
	return event
}

func TestMentionMonitorKeepsOtherRelaysAfterClosed(t *testing.T) {
	refused := make(chan struct{})
	var once sync.Once
	refusing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, buffered, id, _, err := readMentionRequest(w, r)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		if err := sendMentionEnvelope(conn, "CLOSED", id, "rate-limited: retry later"); err != nil {
			t.Error(err)
			return
		}
		once.Do(func() { close(refused) })
		for {
			if _, err := wsutil.ReadClientMessage(buffered.Reader, nil); err != nil {
				return
			}
		}
	}))
	t.Cleanup(refusing.Close)

	healthy := startTestRelay(t)
	monitor, storage := mentionFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer func() {
		cancel()
		monitor.Wait()
	}()
	monitor.Start(ctx, []string{"ws" + strings.TrimPrefix(refusing.URL, "http"), healthy})

	select {
	case <-refused:
	case <-time.After(3 * time.Second):
		t.Fatal("refusing relay did not close its subscription")
	}
	// Give the CLOSED response time to reach the monitor before publishing on
	// the other relay. The old shared subscription stopped here permanently.
	time.Sleep(100 * time.Millisecond)

	event := signedTestMention(t, monitor.relayPubkey, nostr.Now())
	publisher, err := nostr.RelayConnect(ctx, healthy)
	if err != nil {
		t.Fatal(err)
	}
	defer publisher.Close()
	if err := publisher.Publish(ctx, *event); err != nil {
		t.Fatal(err)
	}
	waitForMention(t, storage, event.ID)
}

func TestMentionMonitorBackfillsAfterReconnect(t *testing.T) {
	monitor, storage := mentionFixture(t)
	event := signedTestMention(t, monitor.relayPubkey, nostr.Timestamp(time.Now().Add(-time.Hour).Unix()))
	if err := storage.AdvanceMentionWatermark(time.Now().Unix()); err != nil {
		t.Fatal(err)
	}

	var connections atomic.Int32
	filterSeen := make(chan nostr.Filter, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, buffered, id, filter, err := readMentionRequest(w, r)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		if connections.Add(1) == 1 {
			if err := sendMentionEnvelope(conn, "CLOSED", id, "rate-limited: retry later"); err != nil {
				t.Error(err)
				return
			}
		} else {
			filterSeen <- filter
			if filter.Since != nil && *filter.Since <= event.CreatedAt {
				if err := sendMentionEnvelope(conn, "EVENT", id, event); err != nil {
					t.Error(err)
					return
				}
			}
		}
		for {
			if _, err := wsutil.ReadClientMessage(buffered.Reader, nil); err != nil {
				return
			}
		}
	}))
	t.Cleanup(server.Close)

	ctx, cancel := context.WithCancel(context.Background())
	defer func() {
		cancel()
		monitor.Wait()
	}()
	monitor.Start(ctx, []string{"ws" + strings.TrimPrefix(server.URL, "http")})
	waitForMention(t, storage, event.ID)
	select {
	case filter := <-filterSeen:
		if filter.Since == nil || *filter.Since > event.CreatedAt {
			t.Errorf("reconnect since = %v, missed a note from an hour ago", filter.Since)
		}
	case <-time.After(time.Second):
		t.Fatal("second subscription was not observed")
	}
}
