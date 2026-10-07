package nostr

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"iter"
	"log"
	"net/http"
	"net/textproto"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	ws "github.com/coder/websocket"
	"github.com/puzpuzpuz/xsync/v3"
	"github.com/tidwall/gjson"
)

var subscriptionIDCounter atomic.Int64

var (
	ErrDisconnected = errors.New("<disconnected>")
	ErrPingFailed   = errors.New("<ping failed>")
)

type writeRequest struct {
	msg    []byte
	answer chan error
}

type closeCause struct {
	code   ws.StatusCode
	reason string
}

func (c closeCause) Error() string {
	if c.reason == "" {
		return "relay closed"
	}
	return c.reason
}

// Relay represents a connection to a Nostr relay.
type Relay struct {
	URL           string
	requestHeader http.Header // e.g. for origin header

	// websocket connection
	conn                *ws.Conn
	closeMutex          sync.Mutex
	workers             sync.WaitGroup
	subscriptionWorkers sync.WaitGroup
	shutdownDone        chan struct{}
	writeQueue          chan writeRequest
	closed              *atomic.Bool

	Subscriptions *xsync.MapOf[int64, *Subscription]

	ConnectionError         error
	connectionContext       context.Context // will be canceled when the connection closes
	connectionContextCancel context.CancelCauseFunc

	challenge      string // protected by authStateMutex
	authStateMutex sync.Mutex
	authMutex      sync.Mutex
	authed         bool

	authHandler      func(context.Context, *Relay, *Event) error
	noticeHandler    func(*Relay, string) // NIP-01 NOTICEs
	customHandler    func(string)         // nonstandard unparseable messages
	okCallbacks      map[ID]okcallback
	okCallbacksMutex sync.Mutex
	authRunning      atomic.Bool

	// custom things that aren't often used
	//
	AssumeValid bool // this will skip verifying signatures for events received from this relay
}

// NewRelay returns a new relay. It takes a context that, when canceled, will close the relay connection.
func NewRelay(ctx context.Context, url string, options ...RelayOptions) *Relay {
	var opts RelayOptions
	if len(options) > 0 {
		opts = options[0]
	}
	ctx, cancel := context.WithCancelCause(ctx)
	r := &Relay{
		URL:                     NormalizeURL(url),
		connectionContext:       ctx,
		connectionContextCancel: cancel,
		Subscriptions:           xsync.NewMapOf[int64, *Subscription](),
		okCallbacks:             make(map[ID]okcallback, 20),
		requestHeader:           opts.RequestHeader,
		customHandler:           opts.CustomHandler,
		noticeHandler:           opts.NoticeHandler,
		authHandler:             opts.AuthHandler,
		closed:                  &atomic.Bool{},
		shutdownDone:            make(chan struct{}),
		writeQueue:              make(chan writeRequest),
		AssumeValid:             opts.AssumeValid,
	}

	go func() {
		<-ctx.Done()
		r.closeMutex.Lock()
		r.closed.Store(true)
		conn := r.conn
		r.closeMutex.Unlock()
		if conn != nil {
			_ = conn.CloseNow()
		}
		r.workers.Wait()
		r.subscriptionWorkers.Wait()
		close(r.shutdownDone)
	}()

	return r
}

// RelayConnect returns a relay object connected to url.
//
// The given subscription is only used during the connection phase. Once successfully connected, cancelling ctx has no effect.
//
// The ongoing relay connection uses a background context. To close the connection, call r.Close().
// If you need fine grained long-term connection contexts, use NewRelay() instead.
func RelayConnect(ctx context.Context, url string, opts ...RelayOptions) (*Relay, error) {
	r := NewRelay(context.Background(), url, opts...)
	err := r.Connect(ctx)
	if err != nil {
		r.Close()
	}
	return r, err
}

type RelayOptions struct {
	// AuthHandler is fired when an AUTH message is received. It is given the AUTH event, unsigned, and expects you to sign it.
	AuthHandler func(context.Context, *Relay, *Event) error

	// NoticeHandler just takes notices and is expected to do something with them.
	// When not given defaults to logging the notices.
	NoticeHandler func(relay *Relay, notice string)

	// CustomHandler, if given, must be a function that handles any relay message
	// that couldn't be parsed as a standard envelope.
	CustomHandler func(data string)

	// RequestHeader sets the HTTP request header of the websocket preflight request
	RequestHeader http.Header

	// AssumeValid disables signature verification for events received from this relay
	AssumeValid bool
}

// String just returns the relay URL.
func (r *Relay) String() string {
	return r.URL
}

// Context retrieves the context that is associated with this relay connection.
// It will be closed when the relay is disconnected.
func (r *Relay) Context() context.Context { return r.connectionContext }

// IsConnected returns true if the connection to this relay seems to be active.
func (r *Relay) IsConnected() bool {
	r.closeMutex.Lock()
	defer r.closeMutex.Unlock()
	if r.closed.Load() {
		return false
	}
	if r.conn == nil {
		return false
	}
	if r.connectionContext == nil {
		return false
	}
	return r.connectionContext.Err() == nil
}

// Connect tries to establish a websocket connection to r.URL.
// If the context expires before the connection is complete, an error is returned.
// Once successfully connected, context expiration has no effect: call r.Close
// to close the connection.
//
// The given context here is only used during the connection phase. The long-living
// relay connection will be based on the context given to NewRelay().
func (r *Relay) Connect(ctx context.Context) error {
	return r.ConnectWithClient(ctx, nil)
}

// ConnectWithTLS is like Connect(), but takes a special tls.Config if you need that.
func (r *Relay) ConnectWithTLS(ctx context.Context, tlsConfig *tls.Config) error {
	return r.ConnectWithClient(ctx, &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: tlsConfig,
		},
	})
}

// ConnectWithClient is like Connect(), but takes a special *http.Client if you need that.
func (r *Relay) ConnectWithClient(ctx context.Context, client *http.Client) error {
	r.closeMutex.Lock()
	if r.closed.Load() || r.conn != nil || r.connectionContext.Err() != nil {
		r.closeMutex.Unlock()
		return ErrDisconnected
	}
	r.workers.Add(1)
	r.closeMutex.Unlock()
	defer r.workers.Done()
	ctx, cancelDial := context.WithCancel(ctx)
	defer cancelDial()
	stop := context.AfterFunc(r.connectionContext, cancelDial)
	defer stop()

	if r.connectionContext == nil || r.Subscriptions == nil {
		return fmt.Errorf("relay must be initialized with a call to NewRelay()")
	}
	if r.connectionContext.Err() != nil {
		return fmt.Errorf("relay context canceled")
	}

	if r.URL == "" {
		return fmt.Errorf("invalid relay URL '%s'", r.URL)
	}

	if err := r.newConnection(ctx, client); err != nil {
		return fmt.Errorf("error opening websocket to '%s': %w", r.URL, err)
	}

	return nil
}

func (r *Relay) newConnection(ctx context.Context, httpClient *http.Client) error {
	debugLogf("{%s} connecting!\n", r.URL)

	dialCtx := ctx
	if _, ok := dialCtx.Deadline(); !ok {
		// if no timeout is set, force it to 7 seconds
		var cancel context.CancelFunc
		dialCtx, cancel = context.WithTimeoutCause(ctx, 7*time.Second, errors.New("connection took too long"))
		defer cancel()
	}

	dialOpts := &ws.DialOptions{
		HTTPHeader: http.Header{
			textproto.CanonicalMIMEHeaderKey("User-Agent"): {"fiatjaf.com/nostr"},
		},
		CompressionMode: ws.CompressionContextTakeover,
		HTTPClient:      httpClient,
	}
	for k, v := range r.requestHeader {
		dialOpts.HTTPHeader[k] = v
	}

	c, _, err := ws.Dial(dialCtx, r.URL, dialOpts)
	if err != nil {
		return err
	}
	c.SetReadLimit(1 << 20)

	// ping every 19 seconds
	ticker := time.NewTicker(19 * time.Second)

	// main websocket loop
	readQueue := make(chan string, 1)

	r.closeMutex.Lock()
	if r.closed.Load() || r.connectionContext.Err() != nil || r.conn != nil {
		r.closeMutex.Unlock()
		c.CloseNow()
		ticker.Stop()
		return ErrDisconnected
	}
	r.conn = c
	r.workers.Add(2)
	r.closeMutex.Unlock()

	connCtx := r.connectionContext
	go func() {
		defer r.workers.Done()
		defer ticker.Stop()
		pingAttempt := 0

		for {
			select {
			case <-connCtx.Done():
				return
			case <-ticker.C:
				debugLogf("{%s} pinging\n", r.URL)
				pingCtx, cancel := context.WithTimeoutCause(connCtx, time.Millisecond*800, errors.New("ping took too long"))
				err := c.Ping(pingCtx)
				cancel()

				if err != nil {
					pingAttempt++
					debugLogf("{%s} error writing ping (attempt %d): %v", r.URL, pingAttempt, err)

					if pingAttempt >= 3 {
						debugLogf("{%s} error writing ping after multiple attempts; closing websocket", r.URL)
						_ = r.close(ErrPingFailed)
					}

					continue
				}

				// ping was OK
				debugLogf("{%s} ping OK", r.URL)
				pingAttempt = 0
			case wr := <-r.writeQueue:
				debugLogf("{%s} sending '%v'\n", r.URL, string(wr.msg))
				writeCtx, cancel := context.WithTimeoutCause(connCtx, time.Second*10, errors.New("write took too long"))
				err := c.Write(writeCtx, ws.MessageText, wr.msg)
				cancel()
				if err != nil {
					debugLogf("{%s} closing!, write failed: '%s'\n", r.URL, err)
					_ = r.close(closeCause{code: ws.StatusAbnormalClosure, reason: "write failed"})
					if wr.answer != nil {
						wr.answer <- err
					}
					return
				}
				if wr.answer != nil {
					close(wr.answer)
				}
			case msg := <-readQueue:
				debugLogf("{%s} received %v\n", r.URL, msg)
				r.handleMessage(msg)
			}
		}
	}()

	// read loop -- loops back to the main loop
	go func() {
		defer r.workers.Done()
		buf := new(bytes.Buffer)

		for {
			buf.Reset()

			_, reader, err := c.Reader(connCtx)
			if err != nil {
				debugLogf("{%s} closing!, reader failure: '%s'\n", r.URL, err)
				_ = r.close(closeCause{code: ws.StatusAbnormalClosure, reason: "failed to get reader"})
				return
			}
			if _, err := io.Copy(buf, reader); err != nil {
				debugLogf("{%s} closing!, read failure: '%s'\n", r.URL, err)
				_ = r.close(closeCause{code: ws.StatusAbnormalClosure, reason: "failed to read"})
				return
			}

			if !acceptRelayMessage(int64(buf.Len())) {
				_ = r.close(errors.New("receive budget exceeded"))
				return
			}
			msg := string(buf.Bytes())
			select {
			case readQueue <- msg:
			case <-connCtx.Done():
				return
			}
		}
	}()

	return nil
}

func (r *Relay) handleMessage(message string) {
	envelope, err := ParseMessage(message)
	if envelope == nil {
		if r.customHandler != nil && err == UnknownLabel {
			r.customHandler(message)
		}
		return
	}

	switch env := envelope.(type) {
	case *NoticeEnvelope:
		if r.noticeHandler != nil {
			r.noticeHandler(r, string(*env))
		} else {
			log.Printf("NOTICE from %s: '%s'\n", r.URL, string(*env))
		}
	case *AuthEnvelope:
		if env.Challenge == nil {
			return
		}

		r.authStateMutex.Lock()
		r.challenge = *env.Challenge
		r.authed = false
		r.authStateMutex.Unlock()

		if r.authHandler != nil && r.authRunning.CompareAndSwap(false, true) {
			r.closeMutex.Lock()
			if r.closed.Load() || r.Context().Err() != nil {
				r.closeMutex.Unlock()
				r.authRunning.Store(false)
				return
			}
			r.workers.Add(1)
			r.closeMutex.Unlock()
			go func() {
				defer r.workers.Done()
				defer r.authRunning.Store(false)
				r.Auth(r.Context(), func(ctx context.Context, evt *Event) error {
					return r.authHandler(ctx, r, evt)
				})
			}()
		}
	case *EventEnvelope:
		if env.SubscriptionID == nil {
			return
		}
		sub, ok := r.Subscriptions.Load(subIdToSerial(*env.SubscriptionID))
		if !ok || sub.id != *env.SubscriptionID || !sub.live.Load() || !sub.match(env.Event) {
			return
		}
		if !r.AssumeValid && (!env.Event.CheckID() || !env.Event.VerifySignature()) {
			return
		}
		if sub.checkDuplicate != nil && sub.checkDuplicate(env.Event.ID, r.URL) {
			return
		}
		if sub.checkDuplicateReplaceable != nil && sub.checkDuplicateReplaceable(ReplaceableKey{env.Event.PubKey, env.Event.Tags.GetD()}, env.Event.CreatedAt) {
			return
		}
		sub.dispatchEvent(env.Event)
	case *EOSEEnvelope:
		if subscription, ok := r.Subscriptions.Load(subIdToSerial(env.SubscriptionID)); ok {
			// NIP-67: EOSE may carry a hint as a third element ["EOSE", <subid>, [<hint>...]];
			// EOSEEnvelope only holds the subid, so read it from the raw message.
			var hint []string
			if arr := gjson.Parse(message).Array(); len(arr) >= 3 {
				for _, h := range arr[2].Array() {
					hint = append(hint, h.String())
				}
			}
			subscription.dispatchEose(hint)
		}
	case *ClosedEnvelope:
		if subscription, ok := r.Subscriptions.Load(subIdToSerial(env.SubscriptionID)); ok {
			subscription.handleClosed(env.Reason)
		}
	case *CountEnvelope:
		if subscription, ok := r.Subscriptions.Load(subIdToSerial(env.SubscriptionID)); ok && env.Count != nil && subscription.countResult != nil {
			select {
			case subscription.countResult <- *env:
			case <-subscription.Context.Done():
			default:
			}
		}
	case *OKEnvelope:
		r.okCallbacksMutex.Lock()
		if okCallback, exist := r.okCallbacks[env.EventID]; exist {
			okCallback(env.OK, env.Reason)
		} else {
			InfoLogger.Printf("{%s} got an unexpected OK message for event %s", r.URL, env.EventID)
		}
		r.okCallbacksMutex.Unlock()
	}
}

// Write queues an arbitrary message to be sent to the relay.
func (r *Relay) Write(msg []byte) {
	select {
	case <-r.connectionContext.Done():
	case r.writeQueue <- writeRequest{msg: msg, answer: nil}:
	}
}

// WriteWithError is like Write, but returns an error if the write fails (and the connection gets closed).
func (r *Relay) WriteWithError(msg []byte) error { return r.writeWithContext(r.Context(), msg) }

func (r *Relay) writeWithContext(ctx context.Context, msg []byte) error {
	if !r.IsConnected() {
		return ErrNotConnected
	}
	answer := make(chan error, 1)
	select {
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-r.Context().Done():
		return context.Cause(r.Context())
	case r.writeQueue <- writeRequest{msg: msg, answer: answer}:
	}
	select {
	case err := <-answer:
		return err
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-r.Context().Done():
		return context.Cause(r.Context())
	}
}

// Publish sends an "EVENT" command to the relay r as in NIP-01 and waits for an OK response.
func (r *Relay) Publish(ctx context.Context, event Event) error {
	return r.publish(ctx, event.ID, &EventEnvelope{Event: event})
}

// Auth sends an "AUTH" command client->relay as in NIP-42 and waits for an OK response.
//
// You don't have to build the AUTH event yourself, this function takes a function to which the
// event that must be signed will be passed, so it's only necessary to sign that.
func (r *Relay) Auth(ctx context.Context, sign func(context.Context, *Event) error) error {
	r.authMutex.Lock()
	defer r.authMutex.Unlock()
	r.authStateMutex.Lock()
	challenge, authed := r.challenge, r.authed
	r.authStateMutex.Unlock()
	if authed {
		return nil
	}
	if challenge == "" {
		return errors.New("no challenge, can't AUTH")
	}
	event := Event{CreatedAt: Now(), Kind: KindClientAuthentication, Tags: Tags{{"relay", r.URL}, {"challenge", challenge}}}
	if err := sign(ctx, &event); err != nil {
		return fmt.Errorf("error signing auth event: %w", err)
	}
	if err := r.publish(ctx, event.ID, &AuthEnvelope{Event: event}); err != nil {
		return err
	}
	r.authStateMutex.Lock()
	if r.challenge == challenge {
		r.authed = true
	}
	r.authStateMutex.Unlock()
	return nil
}

// publish keeps acknowledgements bounded and removes them on every exit path.
func (r *Relay) publish(ctx context.Context, id ID, env Envelope) error {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 7*time.Second)
		defer cancel()
	}
	type result struct {
		ok     bool
		reason string
	}
	answer := make(chan result, 1)
	r.okCallbacksMutex.Lock()
	if _, exists := r.okCallbacks[id]; exists || len(r.okCallbacks) >= 48 {
		r.okCallbacksMutex.Unlock()
		return errors.New("publish already in flight or acknowledgement budget exhausted")
	}
	r.okCallbacks[id] = func(ok bool, reason string) {
		select {
		case answer <- result{ok, reason}:
		default:
		}
	}
	r.okCallbacksMutex.Unlock()
	defer func() { r.okCallbacksMutex.Lock(); delete(r.okCallbacks, id); r.okCallbacksMutex.Unlock() }()
	encoded, err := env.MarshalJSON()
	if err != nil {
		return err
	}
	if err := r.writeWithContext(ctx, encoded); err != nil {
		return err
	}
	select {
	case result := <-answer:
		if result.ok {
			return nil
		}
		return fmt.Errorf("msg: %s", result.reason)
	case <-ctx.Done():
		return fmt.Errorf("publish: %w", context.Cause(ctx))
	case <-r.Context().Done():
		return fmt.Errorf("relay: %w", context.Cause(r.Context()))
	}
}

// Subscribe sends a "REQ" command to the relay r as in NIP-01.
// Events are returned through the channel sub.Events.
// The subscription is closed when context ctx is cancelled ("CLOSE" in NIP-01).
//
// Remember to cancel subscriptions, either by calling `.Unsub()` on them or ensuring their `context.Context` will be canceled at some point.
// Failure to do that will result in a huge number of halted goroutines being created.
func (r *Relay) Subscribe(ctx context.Context, filter Filter, opts SubscriptionOptions) (*Subscription, error) {
	if !r.IsConnected() {
		return nil, ErrDisconnected
	}

	sub := r.PrepareSubscription(ctx, filter, opts)

	if err := sub.Fire(); err != nil {
		sub.cancel(ErrFireFailed)
		sub.Unsub()
		return nil, fmt.Errorf("couldn't subscribe to %v at %s: %w", filter, r.URL, err)
	}

	return sub, nil
}

// PrepareSubscription creates a subscription, but doesn't fire it.
//
// Remember to cancel subscriptions, either by calling `.Unsub()` on them or ensuring their `context.Context` will be canceled at some point.
// Failure to do that will result in a huge number of halted goroutines being created.
func (r *Relay) PrepareSubscription(ctx context.Context, filter Filter, opts SubscriptionOptions) *Subscription {
	return r.prepareSubscription(ctx, []Filter{filter}, opts, false)
}

func (r *Relay) prepareSubscription(ctx context.Context, filters []Filter, opts SubscriptionOptions, count bool) *Subscription {
	cloned := make([]Filter, len(filters))
	for i, filter := range filters {
		cloned[i] = filter.Clone()
	}
	filter := cloned[0]
	r.closeMutex.Lock()
	defer r.closeMutex.Unlock()
	active := !r.closed.Load() && r.connectionContext.Err() == nil
	if active {
		r.subscriptionWorkers.Add(1)
	}
	current := subscriptionIDCounter.Add(1)
	ctx, cancel := context.WithCancelCause(ctx)

	sub := &Subscription{
		Relay:             r,
		Context:           ctx,
		cancel:            cancel,
		counter:           current,
		Events:            make(chan Event),
		EndOfStoredEvents: make(chan EndOfStoredEvent, 1),
		ClosedReason:      make(chan string, 1),
		Filter:            filter,
		filters:           cloned,
		match: func(event Event) bool {
			for _, filter := range cloned {
				if filter.Matches(event) {
					return true
				}
			}
			return false
		},
		eoseTimedOut: make(chan struct{}),
		done:         make(chan struct{}),
	}

	if count {
		sub.countResult = make(chan CountEnvelope, 1)
	}
	sub.checkDuplicate = opts.CheckDuplicate
	sub.checkDuplicateReplaceable = opts.CheckDuplicateReplaceable

	// subscription id computation
	buf := subIdPool.Get().([]byte)[:0]
	buf = strconv.AppendInt(buf, sub.counter, 10)
	buf = append(buf, ':')
	buf = append(buf, opts.Label...)
	defer subIdPool.Put(buf)
	sub.id = string(buf)

	if !active {
		sub.cancel(ErrDisconnected)
		close(sub.Events)
		close(sub.done)
		return sub
	}
	// we track subscriptions only by their counter, no need for the full id
	r.Subscriptions.Store(int64(sub.counter), sub)

	// if the relay connection dies, cancel this subscription
	go func() {
		select {
		case <-sub.Context.Done():
			return
		case <-r.connectionContext.Done():
			sub.cancel(context.Cause(r.connectionContext))
		}
	}()

	// start handling events, eose, unsub etc:
	go func() {
		defer r.subscriptionWorkers.Done()
		defer close(sub.done)
		<-sub.Context.Done()

		sub.fireMutex.Lock()
		// Serialize cleanup after any in-flight REQ.
		if sub.live.CompareAndSwap(true, false) {
			closeMsg := CloseEnvelope(sub.id)
			closeb, _ := (&closeMsg).MarshalJSON()
			if err := sub.Relay.WriteWithError(closeb); err != nil {
				_ = sub.Relay.close(err)
			}
		}

		// remove subscription from our map
		sub.Relay.Subscriptions.Delete(sub.counter)
		sub.releaseBudget()
		sub.fireMutex.Unlock()

		// do this so we don't have the possibility of closing the Events channel and then trying to send to it
		sub.mu.Lock()
		close(sub.Events)
		if sub.countResult != nil {
			close(sub.countResult)
		}
		sub.mu.Unlock()
	}()

	return sub
}

// implement Querier interface
func (r *Relay) QueryEvents(filter Filter) iter.Seq[Event] {
	return func(yield func(Event) bool) {
		ctx, cancel := context.WithCancel(r.connectionContext)
		defer cancel()

		sub, err := r.Subscribe(ctx, filter, SubscriptionOptions{Label: "queryevents"})
		if err != nil {
			return
		}

		for {
			select {
			case evt, ok := <-sub.Events:
				if !ok || !yield(evt) {
					return
				}
			case <-sub.EndOfStoredEvents:
				return
			case <-sub.ClosedReason:
				return
			case <-ctx.Done():
				return
			}
		}
	}
}

// Count sends a "COUNT" command to the relay and returns the count of events matching the filters.
// If opts.AutoAuth is set, it will handle "auth-required:" CLOSEs using RelayOptions.AuthHandler.
func (r *Relay) Count(ctx context.Context, filter Filter, opts SubscriptionOptions) (uint32, []byte, error) {
	v, err := r.countInternal(ctx, filter, opts)
	if err != nil {
		return 0, nil, err
	}

	if v.Count == nil {
		return 0, nil, errors.New("count subscription ended without result")
	}

	return *v.Count, v.HyperLogLog, nil
}

func (r *Relay) countInternal(ctx context.Context, filter Filter, opts SubscriptionOptions) (CountEnvelope, error) {
	if !r.IsConnected() {
		return CountEnvelope{}, ErrDisconnected
	}

	if _, ok := ctx.Deadline(); !ok {
		// if no timeout is set, force it to 7 seconds
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeoutCause(ctx, 7*time.Second, errors.New("countInternal took too long"))
		defer cancel()
	}

	hasAuthed := false

	for {
		sub := r.prepareSubscription(ctx, []Filter{filter}, opts, true)

		if err := sub.Fire(); err != nil {
			sub.cancel(ErrFireFailed)
			return CountEnvelope{}, fmt.Errorf("couldn't count %v at %s: %w", filter, r.URL, err)
		}

		for {
			select {
			case count, ok := <-sub.countResult:
				sub.cancel(errors.New("countInternal() ended"))
				if !ok || count.Count == nil {
					return CountEnvelope{}, errors.New("count subscription ended without result")
				}
				return count, nil
			case reason := <-sub.ClosedReason:
				sub.cancel(errors.New("countInternal() ended"))
				if strings.HasPrefix(reason, "auth-required:") && r.authHandler != nil && !hasAuthed {
					authErr := r.Auth(ctx, func(authCtx context.Context, evt *Event) error {
						return r.authHandler(authCtx, r, evt)
					})
					if authErr == nil {
						hasAuthed = true
						goto resubscribe
					}
					return CountEnvelope{}, fmt.Errorf("failed to auth: %w", authErr)
				}
				return CountEnvelope{}, fmt.Errorf("count: CLOSED received: %s", reason)
			case <-sub.Context.Done():
				sub.cancel(errors.New("countInternal() ended"))
				return CountEnvelope{}, context.Cause(sub.Context)
			case <-ctx.Done():
				sub.cancel(errors.New("countInternal() ended"))
				return CountEnvelope{}, ctx.Err()
			}
		}

	resubscribe:
		continue
	}
}

// Close closes the relay connection.
func (r *Relay) Close() error {
	r.close(errors.New("Close() called"))
	<-r.shutdownDone
	return nil
}

func (r *Relay) close(reason error) error {
	r.connectionContextCancel(reason)
	return nil
}

var subIdPool = sync.Pool{
	New: func() any { return make([]byte, 0, 15) },
}

type okcallback func(ok bool, reason string)
