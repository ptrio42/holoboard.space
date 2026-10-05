package nostr

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsutil"
)

// Each server acknowledges socket closure, including hijacked connections that
// httptest.Server.Close cannot close on behalf of the client.
func lifecycleServer(t *testing.T) (string, <-chan struct{}) {
	t.Helper()
	closed := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, _, _, err := ws.UpgradeHTTP(r, w)
		if err != nil {
			return
		}
		defer conn.Close()
		defer close(closed)
		for {
			if _, _, err := wsutil.ReadClientData(conn); err != nil {
				return
			}
		}
	}))
	t.Cleanup(server.Close)
	return "ws" + strings.TrimPrefix(server.URL, "http"), closed
}

func awaitLifecycle(t *testing.T, done <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal(message)
	}
}

func TestRelayCloseJoinsConcurrentWritesAndSubscriptions(t *testing.T) {
	url, socketClosed := lifecycleServer(t)
	relay, err := RelayConnect(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	sub, err := relay.Subscribe(context.Background(), Filters{{Kinds: []int{0}}})
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var writers sync.WaitGroup
	for i := 0; i < 8; i++ {
		writers.Add(1)
		go func() {
			defer writers.Done()
			<-start
			for i := 0; i < 32; i++ {
				if err := <-relay.Write([]byte(`["CLOSE","local-regression"]`)); err != nil {
					return
				}
			}
		}()
	}
	var closes sync.WaitGroup
	closes.Add(8)
	for i := 0; i < 8; i++ {
		go func() { defer closes.Done(); <-start; relay.Close() }()
	}
	close(start)
	done := make(chan struct{})
	go func() { closes.Wait(); writers.Wait(); close(done) }()
	awaitLifecycle(t, done, "concurrent Close or Write remained blocked")
	awaitLifecycle(t, socketClosed, "Close left the socket open")
	awaitLifecycle(t, sub.done, "Close returned before subscription cleanup")
	select {
	case _, open := <-sub.Events:
		if open {
			t.Fatal("subscription remained open")
		}
	default:
		t.Fatal("subscription Events not closed")
	}
	if err := <-relay.Write([]byte(`["CLOSE","after-close"]`)); err == nil {
		t.Fatal("closed relay accepted another write")
	}
}

func TestRelayParentCancellationClosesSocketAndWorkers(t *testing.T) {
	url, socketClosed := lifecycleServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	relay := NewRelay(ctx, url)
	if err := relay.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	sub, err := relay.Subscribe(context.Background(), Filters{{Kinds: []int{0}}})
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	awaitLifecycle(t, socketClosed, "parent cancellation leaked the socket")
	done := make(chan struct{})
	go func() { relay.Close(); close(done) }()
	awaitLifecycle(t, done, "parent cancellation left relay workers blocked")
	awaitLifecycle(t, sub.done, "parent cancellation leaked a subscription")
}

func TestPoolCancellationClosesOwnedRelay(t *testing.T) {
	url, socketClosed := lifecycleServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pool := NewSimplePool(ctx)
	relay, err := pool.EnsureRelay(url)
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	cancel()
	awaitLifecycle(t, socketClosed, "pool cancellation leaked the relay socket")
	done := make(chan struct{})
	go func() { relay.Close(); close(done) }()
	awaitLifecycle(t, done, "pool cancellation left relay workers blocked")
}

func TestRelayCloseUnblocksWriterWithoutAnswerConsumer(t *testing.T) {
	url, socketClosed := lifecycleServer(t)
	relay, err := RelayConnect(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	relay.Write([]byte(`["CLOSE","discarded-answer"]`))
	done := make(chan struct{})
	go func() { relay.Close(); close(done) }()
	awaitLifecycle(t, done, "writer remained blocked delivering an unconsumed result")
	awaitLifecycle(t, socketClosed, "writer shutdown left the socket open")
}

func TestUnconnectedRelayCloseStopsNoticeHandler(t *testing.T) {
	relay := NewRelay(context.Background(), "ws://127.0.0.1", WithNoticeHandler(func(string) {}))
	relay.Close()
	select {
	case _, open := <-relay.notices:
		if open {
			t.Fatal("notice channel remained open")
		}
	default:
		t.Fatal("notice channel not closed")
	}
	relay.Close()
}
