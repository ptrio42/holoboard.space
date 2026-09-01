package khatru

import (
	"context"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/fasthttp/websocket"
	"github.com/rs/cors"
)

func (rl *Relay) Router() *http.ServeMux {
	return rl.serveMux
}

// Start creates an http server and starts listening on given host and port.
func (rl *Relay) Start(host string, port int, started ...chan bool) error {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}

	rl.Addr = ln.Addr().String()
	// PATCH: khatru shipped two second Read and Write timeouts here.
	//
	// They leave websockets alone, which clear their deadlines on upgrade, but
	// they cut off every ordinary HTTP handler mid-response. Minting a Lightning
	// invoice is a round trip to a wallet over nostr and takes seconds, so the
	// reply was killed at two of them and the caller got a 502 from the proxy
	// for an invoice that had in fact been created and stored.
	//
	// ReadHeaderTimeout is the part worth keeping short, since that is what
	// guards against a client dribbling out headers forever.
	rl.httpServer = &http.Server{
		Handler:           cors.Default().Handler(rl),
		Addr:              addr,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       45 * time.Second,
		WriteTimeout:      45 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// notify caller that we're starting
	for _, started := range started {
		close(started)
	}

	if err := rl.httpServer.Serve(ln); err == http.ErrServerClosed {
		return nil
	} else if err != nil {
		return err
	} else {
		return nil
	}
}

// Shutdown sends a websocket close control message to all connected clients.
func (rl *Relay) Shutdown(ctx context.Context) {
	rl.httpServer.Shutdown(ctx)
	rl.clientsMutex.Lock()
	defer rl.clientsMutex.Unlock()
	for ws := range rl.clients {
		ws.conn.WriteControl(websocket.CloseMessage, nil, time.Now().Add(time.Second))
		ws.conn.Close()
	}
	clear(rl.clients)
	rl.listeners = rl.listeners[:0]
}
