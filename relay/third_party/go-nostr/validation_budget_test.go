package nostr

import (
	"bytes"
	"compress/flate"
	"context"
	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsflate"
	"github.com/gobwas/ws/wsutil"
	"io"
	"net"
	"testing"
)

func TestSignatureValidationBindsTheSuppliedID(t *testing.T) {
	event := Event{Kind: 1, CreatedAt: Now(), Tags: Tags{}, Content: "valid"}
	if err := event.Sign(GeneratePrivateKey()); err != nil {
		t.Fatal(err)
	}
	if valid, err := event.CheckSignature(); err != nil || !valid {
		t.Fatal("valid event rejected")
	}
	event.ID = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
	if valid, _ := event.CheckSignature(); valid {
		t.Fatal("forged ID accepted")
	}
}

func TestSubscriptionBudgetReleasesOnUnsubscribe(t *testing.T) {
	url, _ := lifecycleServer(t)
	relay, err := RelayConnect(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	var subscriptions []*Subscription
	for i := 0; i < 8; i++ {
		sub, err := relay.Subscribe(context.Background(), Filters{{Kinds: []int{1}}})
		if err != nil {
			t.Fatal(err)
		}
		subscriptions = append(subscriptions, sub)
	}
	if sub, err := relay.Subscribe(context.Background(), Filters{{Kinds: []int{1}}}); err == nil || sub != nil {
		t.Fatal("per-relay subscription limit not enforced")
	}
	subscriptions[0].Unsub()
	sub, err := relay.Subscribe(context.Background(), Filters{{Kinds: []int{1}}})
	if err != nil {
		t.Fatalf("unsubscribe did not release the budget: %v", err)
	}
	sub.Unsub()
	for _, sub := range subscriptions {
		sub.Unsub()
	}
}

func TestDecompressedMessageBudget(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	frame, err := wsflate.CompressFrame(ws.NewTextFrame(bytes.Repeat([]byte("x"), (1<<20)+1)))
	if err != nil {
		t.Fatal(err)
	}
	var state wsflate.MessageState
	reader := &wsutil.Reader{Source: client, State: ws.StateClientSide | ws.StateExtended, Extensions: []wsutil.RecvExtension{&state}}
	connection := &Connection{conn: client, enableCompression: true, reader: reader, msgStateR: &state,
		flateReader: wsflate.NewReader(nil, func(r io.Reader) wsflate.Decompressor { return flate.NewReader(r) })}
	done := make(chan struct{})
	go func() { defer close(done); ws.WriteFrame(server, frame) }()
	var buffer bytes.Buffer
	if err := connection.ReadMessage(context.Background(), &buffer); err == nil {
		t.Fatal("compressed oversized message accepted")
	}
	if buffer.Len() > (1<<20)+1 {
		t.Fatal("decompressed message exceeded bounded allocation")
	}
	<-done
}
