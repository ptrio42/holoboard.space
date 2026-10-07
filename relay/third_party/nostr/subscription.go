package nostr

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

var (
	ErrNotConnected = errors.New("not connected")
	ErrFireFailed   = errors.New("failed to fire")
)

// Subscription represents a subscription to a relay.
type Subscription struct {
	fireMutex sync.Mutex
	budgeted  bool
	done      chan struct{}
	filters   []Filter
	counter   int64
	id        string

	Relay  *Relay
	Filter Filter

	// for this to be treated as a COUNT and not a REQ this must be set
	countResult chan CountEnvelope

	// the Events channel emits all EVENTs that come in a Subscription
	// will be closed when the subscription ends
	Events chan Event
	mu     sync.Mutex

	// the EndOfStoredEvents channel receives a value when an EOSE comes for that subscription
	EndOfStoredEvents chan EndOfStoredEvent

	// the ClosedReason channel emits the reason when a CLOSED message is received
	ClosedReason chan string

	// Context will be .Done() when the subscription ends
	Context context.Context

	// if it is not nil, checkDuplicate will be called for every event received
	// if it returns true that event will not be processed further.
	checkDuplicate func(id ID, relay string) bool

	// if it is not nil, checkDuplicateReplaceable will be called for every event received
	// if it returns true that event will not be processed further.
	checkDuplicateReplaceable func(rk ReplaceableKey, ts Timestamp) bool

	match        func(Event) bool // this will be either Filters.Match or Filters.MatchIgnoringTimestampConstraints
	live         atomic.Bool
	eosed        atomic.Bool
	eoseTimedOut chan struct{}
	cancel       context.CancelCauseFunc

	// this keeps track of the events we've received before the EOSE that we must dispatch before
	// closing the EndOfStoredEvents channel
	storedwg sync.WaitGroup
}

// EndOfStoredEvent is emitted on Subscription.EndOfStoredEvents when an EOSE arrives.
type EndOfStoredEvent struct {
	// Hint holds the NIP-67 EOSE completeness hint(s) (e.g. "more"/"finish"), or nil.
	Hint []string
}

// All SubscriptionOptions fields are optional
type SubscriptionOptions struct {
	// Label puts a label on the subscription (it is prepended to the automatic id) that is sent to relays.
	Label string

	// CheckDuplicate is a function that, when present, is ran on events before they're parsed.
	// if it returns true the event will be discarded and not processed further.
	CheckDuplicate func(id ID, relay string) bool

	// CheckDuplicateReplaceable is like CheckDuplicate, but runs on replaceable/addressable events
	CheckDuplicateReplaceable func(rk ReplaceableKey, ts Timestamp) bool

	// Retained for API compatibility. Holoboard never synthesizes EOSE; use a context deadline.
	MaxWaitForEOSE time.Duration
}

// GetID returns the subscription ID.
func (sub *Subscription) GetID() string { return sub.id }

func (sub *Subscription) dispatchEvent(evt Event) {
	sub.mu.Lock()
	defer sub.mu.Unlock()
	if sub.live.Load() {
		select {
		case sub.Events <- evt:
		case <-sub.Context.Done():
		case <-sub.Relay.Context().Done():
		}
	}
}

func (sub *Subscription) dispatchEose(hint []string) {
	if sub.eosed.CompareAndSwap(false, true) {
		select {
		case sub.EndOfStoredEvents <- EndOfStoredEvent{Hint: hint}:
		case <-sub.Context.Done():
		}
	}
}

func (sub *Subscription) handleClosed(reason string) {
	select {
	case sub.ClosedReason <- reason:
	default:
	}
	sub.live.Store(false)
	sub.cancel(fmt.Errorf("CLOSED received: %s", reason))
}

// Unsub closes the subscription, sending "CLOSE" to relay as in NIP-01.
// Unsub waits for cleanup and closes sub.Events.
func (sub *Subscription) Unsub() {
	sub.cancel(errors.New("Unsub() called"))
	<-sub.done
}

// Sub sets sub.Filters and then calls sub.Fire(ctx).
// The subscription will be closed if the context expires.
func (sub *Subscription) Sub(_ context.Context, filter Filter) {
	sub.Filter = filter
	sub.Fire()
}

// Fire sends the "REQ" command to the relay.
func (sub *Subscription) Fire() error {
	sub.fireMutex.Lock()
	defer sub.fireMutex.Unlock()
	if err := sub.acquireBudget(); err != nil {
		return err
	}
	if sub.Context.Err() != nil {
		sub.releaseBudget()
		return sub.Context.Err()
	}
	var reqb []byte
	if sub.countResult == nil {
		filters := sub.filters
		if filters == nil {
			filters = []Filter{sub.Filter}
		}
		reqb, _ = ReqEnvelope{sub.id, filters}.MarshalJSON()
	} else {
		reqb, _ = CountEnvelope{sub.id, sub.Filter, nil, nil}.MarshalJSON()
	}

	sub.live.Store(true)
	if err := sub.Relay.writeWithContext(sub.Context, reqb); err != nil {
		err := fmt.Errorf("failed to write: %w", err)
		sub.cancel(err)
		return err
	}

	return nil
}
