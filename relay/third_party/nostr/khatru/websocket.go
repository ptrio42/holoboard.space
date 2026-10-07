package khatru

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"net/http"
	"sync"
	"time"
	"unsafe"

	"fiatjaf.com/nostr"
	"github.com/fasthttp/websocket"
	"github.com/puzpuzpuz/xsync/v3"
)

type WebSocket struct {
	conn  *websocket.Conn
	mutex sync.Mutex

	writeWait time.Duration

	// original request
	Request *http.Request

	// this Context will be canceled whenever the connection is closed from the client side or server-side.
	Context context.Context
	cancel  context.CancelFunc

	// nip42
	Challenge        string
	AuthedPublicKeys []nostr.PubKey
	authLock         sync.Mutex

	// nip77
	negentropySessions *xsync.MapOf[string, *NegentropySession]
}

func (ws *WebSocket) GetID() string {
	ptr := uintptr(unsafe.Pointer(ws))
	var id [8]byte
	binary.LittleEndian.PutUint64(id[:], uint64(ptr))
	return base64.RawURLEncoding.EncodeToString(id[:])
}

func (ws *WebSocket) WriteJSON(any any) error {
	if ws == nil {
		return fmt.Errorf("connection doesn't exist")
	}
	ws.mutex.Lock()
	if ws.writeWait > 0 {
		ws.conn.SetWriteDeadline(time.Now().Add(ws.writeWait))
	}
	err := ws.conn.WriteJSON(any)
	ws.mutex.Unlock()
	return err
}

func (ws *WebSocket) WriteMessage(t int, b []byte) error {
	ws.mutex.Lock()
	if ws.writeWait > 0 {
		ws.conn.SetWriteDeadline(time.Now().Add(ws.writeWait))
	}
	err := ws.conn.WriteMessage(t, b)
	ws.mutex.Unlock()
	return err
}
