package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	coderws "github.com/coder/websocket"
	"github.com/fasthttp/websocket"
)

// Exercise negotiated compression against another implementation, including
// consecutive compressed and uncompressed replies on the same connection.
func TestRelayWebSocketCompressedMessageRoundTrips(t *testing.T) {
	upgrader := websocket.Upgrader{EnableCompression: true}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		for index := 0; ; index++ {
			kind, message, err := connection.ReadMessage()
			if err != nil {
				return
			}
			connection.EnableWriteCompression(index%2 == 0)
			if err := connection.WriteMessage(kind, message); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	connection, _, err := coderws.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), &coderws.DialOptions{CompressionMode: coderws.CompressionContextTakeover})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.CloseNow()
	stop := context.AfterFunc(ctx, func() { connection.CloseNow() })
	defer stop()
	for _, message := range []string{`["REQ","note",{"ids":["` + strings.Repeat("a", 64) + `"]}]`, "", strings.Repeat("A note with repeated text. ", 500), `["CLOSE","note"]`} {
		if err := connection.Write(ctx, coderws.MessageText, []byte(message)); err != nil {
			t.Fatalf("compressed websocket write failed: %v", err)
		}
		_, response, err := connection.Read(ctx)
		if err != nil {
			t.Fatalf("websocket reply failed: %v", err)
		}
		if string(response) != message {
			t.Fatalf("round trip changed message: got %d bytes, want %d", len(response), len(message))
		}
	}
}
