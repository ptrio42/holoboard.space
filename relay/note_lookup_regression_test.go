package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsutil"
	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip19"
)

func TestPreviewFindsNotesUsingAvailableReferenceHints(t *testing.T) {
	previous := discoveryRelays
	discoveryRelays = nil
	t.Cleanup(func() { discoveryRelays = previous })
	index, outbox := startTestRelay(t), startTestRelay(t)
	key := nostr.GeneratePrivateKey()
	note := &nostr.Event{Kind: 1, CreatedAt: nostr.Now(), Content: "Only on the write relay", Tags: nostr.Tags{}}
	list := &nostr.Event{Kind: kindRelayList, CreatedAt: nostr.Now(), Tags: nostr.Tags{{"r", outbox, "write"}}}
	for source, event := range map[string]*nostr.Event{index: list, outbox: note} {
		if err := event.Sign(key); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		connection, err := nostr.RelayConnect(ctx, source)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		err = connection.Publish(ctx, *event)
		connection.Close()
		cancel()
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, test := range []struct {
		name, author string
		hints, reads []string
		want         int
	}{
		{"relay hint only", "", []string{outbox}, []string{index}, http.StatusOK},
		{"author without relay hint", note.PubKey, nil, []string{index}, http.StatusOK},
		{"empty hint with author fallback", note.PubKey, []string{index}, []string{index}, http.StatusOK},
		{"ID without hints on a configured relay", "", nil, []string{outbox}, http.StatusOK},
		{"ID alone cannot locate an unknown write relay", "", nil, []string{index}, http.StatusNotFound},
	} {
		t.Run(test.name, func(t *testing.T) {
			reference, err := nip19.EncodeEvent(note.ID, test.hints, test.author)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := json.Marshal(map[string]string{"note": "https://njump.me/" + reference})
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			request := httptest.NewRequest(http.MethodPost, "/api/promote/preview", bytes.NewReader(body)).WithContext(ctx)
			response := httptest.NewRecorder()
			storage := newTestStorage(t)
			PreviewHandler(storage, NewPostFetcher(test.reads))(response, request)
			if response.Code != test.want {
				t.Fatalf("status=%d body=%s, want %d", response.Code, response.Body.String(), test.want)
			}
			if test.want == http.StatusOK {
				var preview struct {
					Event *nostr.Event `json:"event"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &preview); err != nil || preview.Event == nil || preview.Event.ID != note.ID {
					t.Fatalf("preview lost the original note: %s", response.Body.String())
				}
			}
			if storage.CountPosts() != 0 || len(storage.ListPendingInvoices()) != 0 {
				t.Fatal("preview created a campaign or invoice")
			}
		})
	}
}

// A relay may deliver the requested event without finishing its stored-event
// response. An immutable ID is sufficient to finish this lookup immediately.
func TestFetchPostReturnsBeforeEOSE(t *testing.T) {
	event := &nostr.Event{Kind: 1, CreatedAt: nostr.Now(), Content: "Available before EOSE", Tags: nostr.Tags{}}
	if err := event.Sign(nostr.GeneratePrivateKey()); err != nil {
		t.Fatal(err)
	}
	closed := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, _, _, err := ws.UpgradeHTTP(r, w)
		if err != nil {
			return
		}
		defer conn.Close()
		defer func() { closed <- struct{}{} }()
		for {
			message, _, err := wsutil.ReadClientData(conn)
			if err != nil {
				return
			}
			var envelope []json.RawMessage
			if json.Unmarshal(message, &envelope) != nil || len(envelope) < 3 || string(envelope[0]) != `"REQ"` {
				continue
			}
			var subscription string
			if err := json.Unmarshal(envelope[1], &subscription); err != nil {
				return
			}
			response, _ := json.Marshal([]any{"EVENT", subscription, event})
			if err := wsutil.WriteServerMessage(conn, ws.OpText, response); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 1200*time.Millisecond)
	defer cancel()
	started := time.Now()
	got, source, err := NewPostFetcher([]string{startTestRelay(t)}).FetchPostFromWithRelay(ctx, event.ID, []string{url}, "")
	if err != nil || got == nil || got.ID != event.ID || source != url {
		t.Fatalf("delivered event was not found: event=%v source=%q err=%v", got, source, err)
	}
	if elapsed := time.Since(started); elapsed > 800*time.Millisecond {
		t.Fatalf("lookup waited for EOSE after receiving the exact note: %v", elapsed)
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("successful lookup left its socket open")
	}
}

func TestFetchPostCancellationClosesSockets(t *testing.T) {
	closed := make(chan struct{}, 2)
	connected := make(chan struct{}, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, _, _, err := ws.UpgradeHTTP(r, w)
		if err != nil {
			return
		}
		defer conn.Close()
		defer func() { closed <- struct{}{} }()
		connected <- struct{}{}
		for {
			if _, _, err := wsutil.ReadClientData(conn); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := NewPostFetcher([]string{url + "/one", url + "/two"}).FetchPost(ctx, strings.Repeat("a", 64))
		done <- err
	}()
	for range 2 {
		select {
		case <-connected:
		case <-ctx.Done():
			t.Fatal("lookup did not connect to both relays")
		}
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("lookup did not preserve cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled lookup remained blocked")
	}
	for range 2 {
		select {
		case <-closed:
		case <-time.After(time.Second):
			t.Fatal("cancelled lookup left a relay socket open")
		}
	}
}
