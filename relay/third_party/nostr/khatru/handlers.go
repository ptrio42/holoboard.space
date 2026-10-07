package khatru

import (
	"context"
	"crypto/rand"
	"errors"
	"mime"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
	"unsafe"

	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/nip42"
	"fiatjaf.com/nostr/nip45"
	"fiatjaf.com/nostr/nip45/hyperloglog"
	"fiatjaf.com/nostr/nip70"
	"fiatjaf.com/nostr/nip77"
	"fiatjaf.com/nostr/nip77/negentropy"
	"github.com/bep/debounce"
	"github.com/fasthttp/websocket"
	"github.com/puzpuzpuz/xsync/v3"
	"github.com/rs/cors"
)

func acceptsNostrJSON(values []string) bool {
	for _, value := range values {
		for _, mediaRange := range strings.Split(value, ",") {
			mediaType, params, err := mime.ParseMediaType(strings.TrimSpace(mediaRange))
			if err != nil || mediaType != "application/nostr+json" {
				continue
			}
			if q, ok := params["q"]; ok {
				quality, err := strconv.ParseFloat(q, 64)
				if err != nil || !(quality > 0 && quality <= 1) {
					continue
				}
			}
			return true
		}
	}
	return false
}

// ServeHTTP implements http.Handler interface.
func (rl *Relay) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rl.serviceURLOnce.Do(func() {
		if rl.ServiceURL == "" {
			copyRequest := r.Clone(r.Context())
			copyURL := *r.URL
			copyURL.Path = ""
			copyRequest.URL = &copyURL
			rl.ServiceURL = rl.getBaseURL(copyRequest)
		}
	})
	w.Header().Add("Vary", "Accept")
	corsMiddleware := cors.New(cors.Options{
		AllowedOrigins: []string{"*"},
		AllowedMethods: []string{
			http.MethodHead,
			http.MethodGet,
			http.MethodPost,
			http.MethodPut,
			http.MethodPatch,
			http.MethodDelete,
		},
		AllowedHeaders: []string{"Authorization", "*"},
		MaxAge:         86400,
	})

	relayPathMatches := true
	if serviceURL := rl.getServiceURL(r); serviceURL != "" {
		p, err := url.Parse(serviceURL)
		if err == nil {
			relayPathMatches = strings.TrimSuffix(r.URL.Path, "/") == strings.TrimSuffix(p.Path, "/")
		}
	}

	if relayPathMatches {
		if r.Header.Get("Upgrade") == "websocket" {
			rl.HandleWebsocket(w, r)
			return
		}
		if acceptsNostrJSON(r.Header.Values("Accept")) {
			corsMiddleware.Handler(http.HandlerFunc(rl.HandleNIP11)).ServeHTTP(w, r)
			return
		}
		if r.Header.Get("Content-Type") == "application/nostr+json+rpc" {
			corsMiddleware.Handler(http.HandlerFunc(rl.HandleNIP86)).ServeHTTP(w, r)
			return
		}
	}

	corsMiddleware.Handler(rl.serveMux).ServeHTTP(w, r)
}

func (rl *Relay) HandleWebsocket(w http.ResponseWriter, r *http.Request) {
	if rl.connectionCount.Add(1) > 128 {
		rl.connectionCount.Add(-1)
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	reserved := true
	defer func() {
		if reserved {
			rl.connectionCount.Add(-1)
		}
	}()
	if nil != rl.RejectConnection {
		if rl.RejectConnection(r) {
			w.WriteHeader(429) // Too many requests
			return
		}
	}

	conn, err := rl.upgrader.Upgrade(w, r, nil)
	if err != nil {
		rl.Log.Printf("failed to upgrade websocket: %v\n", err)
		return
	}

	reserved = false
	ticker := time.NewTicker(rl.PingPeriod)

	// NIP-42 challenge
	challenge := make([]byte, 8)
	rand.Read(challenge)

	ws := &WebSocket{
		conn:               conn,
		writeWait:          rl.WriteWait,
		Request:            r,
		Challenge:          rl.ChallengePrefix + nostr.HexEncodeToString(challenge),
		AuthedPublicKeys:   make([]nostr.PubKey, 0),
		negentropySessions: xsync.NewMapOf[string, *NegentropySession](),
	}
	ws.Context, ws.cancel = context.WithCancel(context.Background())

	rl.clientsMutex.Lock()
	rl.clients[ws] = make([]listenerSpec, 0, 2)
	rl.clientsMutex.Unlock()

	ctx, cancel := context.WithCancel(
		context.WithValue(
			context.WithValue(
				context.Background(),
				wsKey, ws,
			),
			httpRequestKey, r,
		),
	)

	killOnce := sync.Once{}
	kill := func() {
		killOnce.Do(func() {
			defer rl.connectionCount.Add(-1)
			if nil != rl.OnDisconnect {
				rl.OnDisconnect(ctx)
			}

			ticker.Stop()
			cancel()
			ws.cancel()
			ws.conn.Close()

			rl.removeClientAndListeners(ws)
		})
	}

	go func() {
		defer kill()

		ws.conn.SetReadLimit(rl.MaxMessageSize)
		ws.conn.SetReadDeadline(time.Now().Add(rl.PongWait))
		ws.conn.SetPongHandler(func(string) error {
			ws.conn.SetReadDeadline(time.Now().Add(rl.PongWait))
			return nil
		})

		if nil != rl.OnConnect {
			rl.OnConnect(ctx)
		}

		for {
			typ, msgb, err := ws.conn.ReadMessage()
			if err != nil {
				if websocket.IsUnexpectedCloseError(
					err,
					websocket.CloseNormalClosure,    // 1000
					websocket.CloseGoingAway,        // 1001
					websocket.CloseNoStatusReceived, // 1005
					websocket.CloseAbnormalClosure,  // 1006
					4537,                            // some client seems to send many of these
				) {
					rl.Log.Printf("unexpected close error from %s: %v\n", GetIPFromRequest(r), err)
				}
				ws.cancel()
				return
			}

			if typ == websocket.PingMessage {
				ws.WriteMessage(websocket.PongMessage, nil)
				continue
			}

			// this is safe because ReadMessage() will always create a new slice
			rl.receiveMutex.Lock()
			if time.Since(rl.receiveStart) >= time.Second {
				rl.receiveStart = time.Now()
				rl.receiveBytes = 0
				rl.receiveMessages = 0
			}
			rl.receiveBytes += len(msgb)
			rl.receiveMessages++
			allowed := rl.receiveBytes <= 16<<20 && rl.receiveMessages <= 1024
			rl.receiveMutex.Unlock()
			if !allowed {
				return
			}
			message := unsafe.String(unsafe.SliceData(msgb), len(msgb))

			func(message string) {
				envelope, err := nostr.ParseMessage(message)
				if err != nil {
					if err == nostr.UnknownLabel && rl.Negentropy {
						envelope = nip77.ParseNegMessage(message)
					}
					if envelope == nil {
						ws.WriteJSON(nostr.NoticeEnvelope("failed to parse envelope: " + err.Error()))
						return
					}
				}

				switch env := envelope.(type) {
				case *nostr.EventEnvelope:
					// check id
					if !env.Event.CheckID() {
						ws.WriteJSON(nostr.OKEnvelope{EventID: env.Event.ID, OK: false, Reason: "invalid: id is computed incorrectly"})
						return
					}

					// check signature
					if !env.Event.VerifySignature() {
						ws.WriteJSON(nostr.OKEnvelope{EventID: env.Event.ID, OK: false, Reason: "invalid: signature is invalid"})
						return
					}

					// check NIP-70 protected
					if nip70.IsProtected(env.Event) {
						authed, is := GetAuthed(ctx)
						if !is {
							RequestAuth(ctx)
							ws.WriteJSON(nostr.OKEnvelope{
								EventID: env.Event.ID,
								OK:      false,
								Reason:  "auth-required: must be published by authenticated event author",
							})
							return
						} else if authed != env.Event.PubKey {
							ws.WriteJSON(nostr.OKEnvelope{
								EventID: env.Event.ID,
								OK:      false,
								Reason:  "blocked: must be published by event author",
							})
							return
						}
					} else if nip70.HasEmbeddedProtected(env.Event) {
						ws.WriteJSON(nostr.OKEnvelope{
							EventID: env.Event.ID,
							OK:      false,
							Reason:  "blocked: can't repost nip70 protected",
						})
						return
					}

					var ok bool
					var writeErr error
					var skipBroadcast bool

					if env.Event.Kind == nostr.KindDeletion {
						// store the delete event first
						skipBroadcast, writeErr = rl.handleNormal(ctx, env.Event)
						if writeErr == nil {
							// this always returns "blocked: " whenever it returns an error
							writeErr = rl.handleDeleteRequest(ctx, env.Event)
							if writeErr == ErrNothingToDelete {
								writeErr = nil
							}
						}
					} else if env.Event.Kind.IsEphemeral() {
						// this will also always return a prefixed reason
						writeErr = rl.handleEphemeral(ctx, env.Event)
					} else {
						// this will also always return a prefixed reason
						skipBroadcast, writeErr = rl.handleNormal(ctx, env.Event)
					}

					var reason string
					if writeErr == nil {
						ok = true
						if !skipBroadcast {
							n := rl.notifyListeners(env.Event, false)

							// the number of notified listeners matters in ephemeral events
							if env.Event.Kind.IsEphemeral() {
								if n == 0 && nil == rl.OnEphemeralEvent {
									ok = false
									reason = "mute: no one was listening for this"
								} else {
									if nil == rl.OnEphemeralEvent {
										reason = "broadcasted to " + strconv.Itoa(n)
									} else {
										reason += "handled internally"
									}
								}
							}
						}
					} else {
						ok = false
						reason = writeErr.Error()
						if strings.HasPrefix(reason, "auth-required:") {
							RequestAuth(ctx)
						}
					}
					ws.WriteJSON(nostr.OKEnvelope{EventID: env.Event.ID, OK: ok, Reason: reason})
				case *nostr.CountEnvelope:
					if rl.Count == nil && rl.CountHLL == nil {
						ws.WriteJSON(nostr.ClosedEnvelope{SubscriptionID: env.SubscriptionID, Reason: "unsupported: this relay does not support NIP-45"})
						return
					}

					var total uint32
					var hll *hyperloglog.HyperLogLog

					if offset := nip45.HyperLogLogEventPubkeyOffsetForFilter(env.Filter); offset != -1 {
						total, hll = rl.handleCountRequestWithHLL(ctx, ws, env.Filter, offset)
					} else {
						total = rl.handleCountRequest(ctx, ws, env.Filter)
					}

					resp := nostr.CountEnvelope{
						SubscriptionID: env.SubscriptionID,
						Count:          &total,
					}
					if hll != nil && hll.Count() > 0 {
						resp.HyperLogLog = hll.GetRegisters()
					}

					ws.WriteJSON(resp)

				case *nostr.ReqEnvelope:
					rl.removeListenerId(ws, env.SubscriptionID)
					if utf8.RuneCountInString(env.SubscriptionID) == 0 || utf8.RuneCountInString(env.SubscriptionID) > 64 || len(env.Filters) == 0 || len(env.Filters) > 8 {
						ws.WriteJSON(nostr.ClosedEnvelope{SubscriptionID: env.SubscriptionID, Reason: "restricted: filter budget exceeded"})
						return
					}
					if rl.queryCount.Add(1) > 32 {
						rl.queryCount.Add(-1)
						ws.WriteJSON(nostr.ClosedEnvelope{SubscriptionID: env.SubscriptionID, Reason: "restricted: query budget exceeded"})
						return
					}
					reqCtx, cancelReqCtx := context.WithCancelCause(ctx)
					reqCtx = context.WithValue(reqCtx, subscriptionIdKey, env.SubscriptionID)
					for _, filter := range env.Filters {
						if rl.OnRequest != nil {
							if reject, msg := rl.OnRequest(reqCtx, filter); reject {
								if strings.HasPrefix(msg, "auth-required:") {
									RequestAuth(ctx)
								}
								rl.queryCount.Add(-1)
								rl.removeListenerId(ws, env.SubscriptionID)
								cancelReqCtx(errors.New(msg))
								ws.WriteJSON(nostr.ClosedEnvelope{SubscriptionID: env.SubscriptionID, Reason: nostr.NormalizeOKMessage(msg, "blocked")})
								return
							}
						}
						if !rl.addListener(ws, env.SubscriptionID, filter, cancelReqCtx) {
							rl.queryCount.Add(-1)
							rl.removeListenerId(ws, env.SubscriptionID)
							cancelReqCtx(errors.New("listener budget exceeded"))
							ws.WriteJSON(nostr.ClosedEnvelope{SubscriptionID: env.SubscriptionID, Reason: "restricted: listener budget exceeded"})
							return
						}
					}
					go func(env *nostr.ReqEnvelope) {
						defer rl.queryCount.Add(-1)
						for _, filter := range env.Filters {
							if err := rl.handleRequest(reqCtx, env.SubscriptionID, ws, filter); err != nil {
								if reqCtx.Err() != nil {
									return
								}
								ws.WriteJSON(nostr.ClosedEnvelope{SubscriptionID: env.SubscriptionID, Reason: err.Error()})
								rl.removeListenerId(ws, env.SubscriptionID)
								cancelReqCtx(err)
								return
							}
						}
						if reqCtx.Err() == nil {
							ws.WriteJSON(nostr.EOSEEnvelope{SubscriptionID: env.SubscriptionID})
						}
					}(env)
				case *nostr.CloseEnvelope:
					id := string(*env)
					rl.removeListenerId(ws, id)
				case *nostr.AuthEnvelope:
					wsBaseUrl := strings.Replace(rl.getBaseURL(r), "http", "ws", 1)
					if pubkey, err := nip42.ValidateAuthEvent(env.Event, ws.Challenge, wsBaseUrl); err == nil {
						ws.authLock.Lock()
						total := len(ws.AuthedPublicKeys)
						if idx := slices.Index(ws.AuthedPublicKeys, pubkey); idx == -1 {
							// this public key is not authenticated
							if total < rl.MaxAuthenticatedClients {
								// add it to the end (the last pubkey is the one we'll use in a single-user context)
								ws.AuthedPublicKeys = append(ws.AuthedPublicKeys, pubkey)
							} else {
								// remove the first (oldest) and add the new pubkey to the end
								ws.AuthedPublicKeys[0] = ws.AuthedPublicKeys[total-1]
								ws.AuthedPublicKeys[total-1] = pubkey
							}
						} else {
							// this is already authed, so move it to the end
							ws.AuthedPublicKeys[idx], ws.AuthedPublicKeys[total-1] = ws.AuthedPublicKeys[total-1], ws.AuthedPublicKeys[idx]
						}
						ws.authLock.Unlock()
						ws.WriteJSON(nostr.OKEnvelope{EventID: env.Event.ID, OK: true})
						if rl.OnAuth != nil {
							rl.OnAuth(ctx, pubkey)
						}
					} else {
						ws.WriteJSON(nostr.OKEnvelope{EventID: env.Event.ID, OK: false, Reason: "error: failed to authenticate: " + err.Error()})
					}
				case *nip77.OpenEnvelope:
					if !rl.Negentropy {
						// ignore
						return
					}
					vec, err := rl.startNegentropySession(ctx, env.Filter)
					if err != nil {
						// fail everything if any filter is rejected
						reason := err.Error()
						if strings.HasPrefix(reason, "auth-required:") {
							RequestAuth(ctx)
						}
						ws.WriteJSON(nip77.ErrorEnvelope{SubscriptionID: env.SubscriptionID, Reason: reason})
						return
					}

					// reconcile to get the next message and return it
					neg := negentropy.New(vec, 1024*1024, false, false)
					out, err := neg.Reconcile(env.Message)
					if err != nil {
						ws.WriteJSON(nip77.ErrorEnvelope{SubscriptionID: env.SubscriptionID, Reason: err.Error()})
						return
					}
					ws.WriteJSON(nip77.MessageEnvelope{SubscriptionID: env.SubscriptionID, Message: out})

					// if the message is not empty that means we'll probably have more reconciliation sessions, so store this
					if out != "" {
						deb := debounce.New(time.Minute * 2)
						negSession := &NegentropySession{
							neg: neg,
							postponeClose: func() {
								deb(func() {
									ws.negentropySessions.Delete(env.SubscriptionID)
								})
							},
						}
						negSession.postponeClose()

						ws.negentropySessions.Store(env.SubscriptionID, negSession)
					}
				case *nip77.MessageEnvelope:
					negSession, ok := ws.negentropySessions.Load(env.SubscriptionID)
					if !ok {
						// bad luck, your request was destroyed
						ws.WriteJSON(nip77.ErrorEnvelope{SubscriptionID: env.SubscriptionID, Reason: "CLOSED"})
						return
					}
					// reconcile to get the next message and return it
					out, err := negSession.neg.Reconcile(env.Message)
					if err != nil {
						ws.WriteJSON(nip77.ErrorEnvelope{SubscriptionID: env.SubscriptionID, Reason: err.Error()})
						ws.negentropySessions.Delete(env.SubscriptionID)
						return
					}
					ws.WriteJSON(nip77.MessageEnvelope{SubscriptionID: env.SubscriptionID, Message: out})

					// if there is more reconciliation to do, postpone this
					if out != "" {
						negSession.postponeClose() // we will close this session after 2 minutes of no activity
					} else {
						// otherwise we can just close it
						ws.WriteJSON(nip77.CloseEnvelope{SubscriptionID: env.SubscriptionID})
						ws.negentropySessions.Delete(env.SubscriptionID)
					}
				case *nip77.CloseEnvelope:
					ws.negentropySessions.Delete(env.SubscriptionID)
				}
			}(message)
		}
	}()

	go func() {
		defer kill()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				err := ws.WriteMessage(websocket.PingMessage, nil)
				if err != nil {
					if !strings.HasSuffix(err.Error(), "use of closed network connection") {
						rl.Log.Printf("error writing ping: %v; closing websocket\n", err)
					}
					return
				}
			}
		}
	}()
}
