package khatru

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"iter"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"fiatjaf.com/lib/channelmutex"
	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/eventstore"
	"fiatjaf.com/nostr/nip11"
	"fiatjaf.com/nostr/nip45/hyperloglog"
	"github.com/fasthttp/websocket"
)

func NewRelay() *Relay {
	ctx, cancel := context.WithCancelCause(context.Background())

	rl := &Relay{
		ctx:    ctx,
		cancel: cancel,

		Log: log.New(os.Stderr, "[khatru-relay] ", log.LstdFlags),

		Info: &nip11.RelayInformationDocument{
			Software:      "https://pkg.go.dev/fiatjaf.com/nostr/khatru",
			Version:       "n/a",
			SupportedNIPs: []any{1, 11, 42, 70, 86},
		},

		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin:     func(r *http.Request) bool { return true },
		},

		clients:      make(map[*WebSocket][]listenerSpec, 100),
		clientsMutex: channelmutex.New(),

		dispatcher: newDispatcher(),

		serveMux: &http.ServeMux{},

		WriteWait:      10 * time.Second,
		PongWait:       60 * time.Second,
		PingPeriod:     30 * time.Second,
		MaxMessageSize: 512000,

		MaxAuthenticatedClients: 8,
	}

	return rl
}

type Relay struct {
	serviceURLOnce  sync.Once
	connectionCount atomic.Int32
	queryCount      atomic.Int32
	receiveMutex    sync.Mutex
	receiveStart    time.Time
	receiveBytes    int
	receiveMessages int
	ctx             context.Context
	cancel          context.CancelCauseFunc

	// setting this variable overwrites the hackish workaround we do to try to figure out our own base URL.
	// it also ensures the relay stuff is served only from that path and not from any path possible.
	ServiceURL string

	// hooks that will be called at various times
	OnEvent                   func(ctx context.Context, event nostr.Event) (reject bool, msg string)
	StoreEvent                func(ctx context.Context, event nostr.Event) error
	ReplaceEvent              func(ctx context.Context, event nostr.Event) error
	DeleteEvent               func(ctx context.Context, id nostr.ID) error
	OnEventSaved              func(ctx context.Context, event nostr.Event)
	OnEventDeleted            func(ctx context.Context, deleted nostr.Event)
	AllowDeleting             func(ctx context.Context, target, deletion nostr.Event) bool
	OnEphemeralEvent          func(ctx context.Context, event nostr.Event)
	OnRequest                 func(ctx context.Context, filter nostr.Filter) (reject bool, msg string)
	OnCount                   func(ctx context.Context, filter nostr.Filter) (reject bool, msg string)
	QueryStored               func(ctx context.Context, filter nostr.Filter) iter.Seq[nostr.Event]
	Count                     func(ctx context.Context, filter nostr.Filter) (uint32, error)
	CountHLL                  func(ctx context.Context, filter nostr.Filter, offset int) (uint32, *hyperloglog.HyperLogLog, error)
	RejectConnection          func(r *http.Request) bool
	OnConnect                 func(ctx context.Context)
	OnDisconnect              func(ctx context.Context)
	OnAuth                    func(ctx context.Context, pubkey nostr.PubKey)
	OnListenerAdded           func(ws *WebSocket, ssid int, id string, filter nostr.Filter)
	OnListenerRemoved         func(ws *WebSocket, ssid int, id string, filter nostr.Filter)
	OverwriteRelayInformation func(ctx context.Context, r *http.Request, info nip11.RelayInformationDocument) nip11.RelayInformationDocument
	OverwriteSupportedMethods func(ctx context.Context, methods []string) []string
	PreventBroadcast          func(ws *WebSocket, filter nostr.Filter, event nostr.Event) bool

	// this can be ignored unless you know what you're doing
	ChallengePrefix string

	// setting up handlers here will enable these methods
	ManagementAPI RelayManagementAPI

	// editing info will affect the NIP-11 responses
	Info *nip11.RelayInformationDocument

	// Default logger, as set by NewServer, is a stdlib logger prefixed with "[khatru-relay] ",
	// outputting to stderr.
	Log *log.Logger

	// for establishing websockets
	upgrader websocket.Upgrader

	// keep a connection reference to all connected clients for Server.Shutdown
	// also used for keeping track of who is listening to what
	clients      map[*WebSocket][]listenerSpec
	dispatcher   dispatcher
	clientsMutex *channelmutex.Mutex

	// set this to true to support negentropy
	Negentropy bool

	// in case you call Server.Start
	Addr       string
	serveMux   *http.ServeMux
	httpServer *http.Server

	// websocket options
	WriteWait               time.Duration // Time allowed to write a message to the peer.
	PongWait                time.Duration // Time allowed to read the next pong message from the peer.
	PingPeriod              time.Duration // Send pings to peer with this period. Must be less than pongWait.
	MaxMessageSize          int64         // Maximum message size allowed from peer.
	MaxAuthenticatedClients int

	// NIP-40 expiration manager
	expirationManager *expirationManager
}

// UseEventstore hooks up an eventstore.Store into the relay in the default way.
// It should be used in 85% of the cases, when you don't want to do any complicated scheme with your event storage.
//
// maxQueryLimit is the default max limit to be enforced when querying events, to prevent users for downloading way
// too much, setting it to something like 500 or 1000 should be ok in most cases.
func (rl *Relay) UseEventstore(store eventstore.Store, maxQueryLimit int) {
	rl.QueryStored = func(ctx context.Context, filter nostr.Filter) iter.Seq[nostr.Event] {
		maxLimit := maxQueryLimit
		if IsNegentropySession(ctx) {
			maxLimit = maxQueryLimit * 20
		}

		return store.QueryEvents(filter, maxLimit)
	}
	rl.Count = func(ctx context.Context, filter nostr.Filter) (uint32, error) {
		return store.CountEvents(filter)
	}
	rl.StoreEvent = func(ctx context.Context, event nostr.Event) error {
		return store.SaveEvent(event)
	}
	rl.ReplaceEvent = func(ctx context.Context, event nostr.Event) error {
		_, err := store.ReplaceEvent(event)
		return err
	}
	rl.DeleteEvent = func(ctx context.Context, id nostr.ID) error {
		return store.DeleteEvent(id)
	}

	// only when using the eventstore we automatically set up the expiration manager
	rl.StartExpirationManager(func(ctx context.Context, filter nostr.Filter) iter.Seq[nostr.Event] {
		return rl.QueryStored(ctx, filter)
	}, func(ctx context.Context, id nostr.ID) error {
		return rl.DeleteEvent(ctx, id)
	}, func(ctx context.Context, evt nostr.Event) {
		if rl.OnEventDeleted != nil {
			rl.OnEventDeleted(ctx, evt)
		}
	})
}

func (rl *Relay) getBaseURL(r *http.Request) string {
	if serviceURL := rl.getServiceURL(r); serviceURL != "" {
		return serviceURL
	}

	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	proto := r.Header.Get("X-Forwarded-Proto")
	if proto == "" {
		if host == "localhost" {
			proto = "http"
		} else if strings.Contains(host, ":") {
			// has a port number
			proto = "http"
		} else if _, err := strconv.Atoi(strings.ReplaceAll(host, ".", "")); err == nil {
			// it's a naked IP
			proto = "http"
		} else {
			proto = "https"
		}
	}

	return proto + "://" + host + r.URL.Path
}

func (rl *Relay) getServiceURL(r *http.Request) string {
	if serviceURL, ok := r.Context().Value(serviceURLOverrideKey).(string); ok {
		return serviceURL
	}

	return rl.ServiceURL
}

// Stats returns the current number of connected clients and open listeners.
func (rl *Relay) Stats() (clients, listeners int) {
	rl.clientsMutex.Lock()
	defer rl.clientsMutex.Unlock()

	for _, specs := range rl.clients {
		listeners += len(specs)
	}

	return len(rl.clients), listeners
}

type ClientInfo struct {
	ID                string
	IP                string
	UserAgent         string
	Origin            string
	Authenticated     []nostr.PubKey
	SubscriptionCount int
}

type SubscriptionInfo struct {
	ID     string
	Filter nostr.Filter
}

type ClientSnapshot struct {
	ClientInfo
	Subscriptions []SubscriptionInfo
}

func (rl *Relay) ListClients() []ClientInfo {
	rl.clientsMutex.Lock()
	defer rl.clientsMutex.Unlock()

	clients := make([]ClientInfo, 0, len(rl.clients))
	for ws, specs := range rl.clients {
		clients = append(clients, ClientInfo{
			ID:                ws.GetID(),
			IP:                GetIPFromRequest(ws.Request),
			UserAgent:         ws.Request.UserAgent(),
			Origin:            ws.Request.Header.Get("Origin"),
			Authenticated:     ws.AuthedPublicKeys,
			SubscriptionCount: len(specs),
		})
	}

	return clients
}

func (rl *Relay) GetClientSnapshot(id string) (ClientSnapshot, bool) {
	rl.clientsMutex.Lock()
	defer rl.clientsMutex.Unlock()

	ptrn, err := base64.RawURLEncoding.DecodeString(id)
	if err != nil {
		return ClientSnapshot{}, false
	}
	ptr := binary.LittleEndian.Uint64(ptrn)

	// DANGEROUS:
	// don't try to do anything with this `ws` object before we confirm it exists by checking the rl.clients map
	ws := (*WebSocket)(unsafe.Pointer(uintptr(ptr)))
	specs, ok := rl.clients[ws]
	if !ok {
		return ClientSnapshot{}, false
	}

	details := ClientSnapshot{
		ClientInfo: ClientInfo{
			ID:                id,
			IP:                GetIPFromRequest(ws.Request),
			UserAgent:         ws.Request.UserAgent(),
			Origin:            ws.Request.Header.Get("Origin"),
			Authenticated:     ws.AuthedPublicKeys,
			SubscriptionCount: len(specs),
		},
		Subscriptions: make([]SubscriptionInfo, 0, len(specs)),
	}

	for _, spec := range specs {
		filter := nostr.Filter{}
		if sub, ok := rl.dispatcher.subscriptions.Load(spec.ssid); ok {
			filter = sub.filter
		}

		details.Subscriptions = append(details.Subscriptions, SubscriptionInfo{
			ID:     spec.sid,
			Filter: filter,
		})
	}

	return details, true
}

func (rl *Relay) Router() *http.ServeMux {
	return rl.serveMux
}

func (rl *Relay) SetRouter(mux *http.ServeMux) {
	rl.serveMux = mux
}

func (rl *Relay) WithServiceURL(serviceURL string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), serviceURLOverrideKey, serviceURL)
		rl.ServeHTTP(w, r.WithContext(ctx))
	})
}
