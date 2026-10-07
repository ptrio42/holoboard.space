package nostr

import (
	"bytes"
	"compress/flate"
	"context"
	"io"
	"net"
	"testing"
	"time"

	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsflate"
	"github.com/gobwas/ws/wsutil"
)

// A message ends with a sync flush, not the compressor's final stream block.
// wsflate.CompressFrame calls both Flush and Close and fails on Go 1.27.
func compressedTestFrame(t *testing.T, data []byte) ws.Frame {
	t.Helper()
	var buffer bytes.Buffer
	writer := wsflate.NewWriter(&buffer, func(w io.Writer) wsflate.Compressor {
		compressor, err := flate.NewWriter(w, 4)
		if err != nil {
			t.Fatal(err)
		}
		return compressor
	})
	if _, err := writer.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatal(err)
	}
	frame := ws.NewTextFrame(buffer.Bytes())
	var err error
	frame.Header, err = wsflate.SetBit(frame.Header)
	if err != nil {
		t.Fatal(err)
	}
	return frame
}

func TestCompressedWritesRoundTripAndReset(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	client.SetDeadline(time.Now().Add(5 * time.Second))
	server.SetDeadline(time.Now().Add(5 * time.Second))
	var state wsflate.MessageState
	state.SetCompressed(true)
	writer := wsutil.NewWriter(client, ws.StateClientSide|ws.StateExtended, ws.OpText)
	writer.SetExtensions(&state)
	connection := &Connection{conn: client, enableCompression: true, writer: writer, msgStateW: &state,
		flateWriter: wsflate.NewWriter(nil, func(w io.Writer) wsflate.Compressor {
			compressor, err := flate.NewWriter(w, 4)
			if err != nil {
				t.Fatal(err)
			}
			return compressor
		})}
	for _, data := range [][]byte{nil, []byte("REQ"), bytes.Repeat([]byte("Nostr"), 1000), []byte("CLOSE")} {
		done := make(chan error, 1)
		go func() { done <- connection.WriteMessage(context.Background(), data) }()
		frame, readErr := ws.ReadFrame(server)
		writeErr := <-done
		if writeErr != nil {
			t.Fatalf("compressed write failed: %v", writeErr)
		}
		if readErr != nil {
			t.Fatal(readErr)
		}
		compressed, err := wsflate.IsCompressed(frame.Header)
		if !frame.Header.Masked || !compressed || err != nil {
			t.Fatal("expected masked compressed client frame")
		}
		ws.Cipher(frame.Payload, frame.Header.Mask, 0)
		reader := wsflate.NewReader(bytes.NewReader(frame.Payload), func(r io.Reader) wsflate.Decompressor { return flate.NewReader(r) })
		decoded, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(decoded, data) {
			t.Fatal("compressed payload changed")
		}
	}
}
