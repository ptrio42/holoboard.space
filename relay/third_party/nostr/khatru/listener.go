package khatru

import (
	"context"
	"errors"
	"iter"
	"sync"

	"fiatjaf.com/lib/set"
	"fiatjaf.com/nostr"
	"github.com/puzpuzpuz/xsync/v3"
)

var ErrSubscriptionClosedByClient = errors.New("subscription closed by client")

type listenerSpec struct {
	ssid   int    // internal numeric id for a listener
	sid    string // client-provided subscription id
	cancel context.CancelCauseFunc
}

type listener struct {
	id     string // duplicated here so we can easily send it on notifyListeners
	filter nostr.Filter
	ws     *WebSocket
}

type subscription struct {
	id     string
	filter nostr.Filter
	ws     *WebSocket
}

type dispatcher struct {
	serial          int
	subscriptions   *xsync.MapOf[int, subscription]
	byAuthor        *xsync.MapOf[nostr.PubKey, set.Set[int]]
	byKind          *xsync.MapOf[nostr.Kind, set.Set[int]]
	fallbackTags    set.Set[int]
	fallbackNothing set.Set[int]
}

var setPool = sync.Pool{
	New: func() any {
		return set.NewEmptySliceSetReusing[int](make([]int, 0, 10))
	},
}

func newDispatcher() dispatcher {
	return dispatcher{
		subscriptions:   xsync.NewMapOf[int, subscription](),
		byAuthor:        xsync.NewMapOf[nostr.PubKey, set.Set[int]](),
		byKind:          xsync.NewMapOf[nostr.Kind, set.Set[int]](),
		fallbackTags:    setPool.Get().(set.Set[int]),
		fallbackNothing: setPool.Get().(set.Set[int]),
	}
}

func (d *dispatcher) addSubscription(sub subscription) int {
	d.serial++
	ssid := d.serial

	d.subscriptions.Store(ssid, sub)

	indexed := false
	if sub.filter.Authors != nil {
		indexed = true
		for _, author := range sub.filter.Authors {
			d.byAuthor.Compute(author, func(s set.Set[int], loaded bool) (set.Set[int], bool) {
				if !loaded {
					s = setPool.Get().(set.Set[int])
				}
				s.Add(ssid)
				return s, false
			})
		}
	}

	if sub.filter.Kinds != nil {
		indexed = true
		for _, kind := range sub.filter.Kinds {
			d.byKind.Compute(kind, func(s set.Set[int], loaded bool) (set.Set[int], bool) {
				if !loaded {
					s = setPool.Get().(set.Set[int])
				}
				s.Add(ssid)
				return s, false
			})
		}
	}

	if !indexed {
		if sub.filter.Tags != nil {
			d.fallbackTags.Add(ssid)
		} else {
			d.fallbackNothing.Add(ssid)
		}
	}

	return ssid
}

func (d *dispatcher) removeSubscription(ssid int) nostr.Filter {
	var filter nostr.Filter

	d.subscriptions.Compute(ssid, func(sub subscription, loaded bool) (subscription, bool) {
		indexed := false

		filter = sub.filter

		if sub.filter.Authors != nil {
			indexed = true
			for _, author := range sub.filter.Authors {
				d.byAuthor.Compute(author, func(s set.Set[int], loaded bool) (set.Set[int], bool) {
					if !loaded {
						return s, true
					}
					s.Remove(ssid)

					delete := s.Len() == 0
					if delete {
						setPool.Put(s)
					}
					return s, delete
				})
			}
		}

		if sub.filter.Kinds != nil {
			indexed = true
			for _, kind := range sub.filter.Kinds {
				d.byKind.Compute(kind, func(s set.Set[int], loaded bool) (set.Set[int], bool) {
					if !loaded {
						return s, true
					}
					s.Remove(ssid)

					delete := s.Len() == 0
					if delete {
						setPool.Put(s)
					}
					return s, delete
				})
			}
		}

		if !indexed {
			if sub.filter.Tags != nil {
				d.fallbackTags.Remove(ssid)
			} else {
				d.fallbackNothing.Remove(ssid)
			}
		}

		return sub, true
	})

	return filter
}

func (d *dispatcher) candidates(event nostr.Event) iter.Seq[subscription] {
	return func(yield func(subscription) bool) {
		authorSubs, hasAuthorSubs := d.byAuthor.Load(event.PubKey)
		kindSubs, hasKindSubs := d.byKind.Load(event.Kind)

		if hasAuthorSubs && hasKindSubs {
			for _, ssid := range authorSubs.Slice() {
				sub, ok := d.subscriptions.Load(ssid)
				if !ok {
					continue
				}

				if kindSubs.Has(ssid) || sub.filter.Kinds == nil {
					if filterMatchesTimestampConstraintsAndTags(sub.filter, event) {
						if !yield(sub) {
							return
						}
					}
				}
			}

			for _, ssid := range kindSubs.Slice() {
				sub, ok := d.subscriptions.Load(ssid)
				if !ok {
					continue
				}

				if sub.filter.Authors != nil {
					continue
				}

				if filterMatchesTimestampConstraintsAndTags(sub.filter, event) {
					if !yield(sub) {
						return
					}
				}
			}
		} else if hasAuthorSubs {
			for _, ssid := range authorSubs.Slice() {
				sub, ok := d.subscriptions.Load(ssid)
				if !ok {
					continue
				}

				if sub.filter.Kinds != nil {
					// if there are any kinds in the filter we already know this doesn't qualify
					continue
				}

				if filterMatchesTimestampConstraintsAndTags(sub.filter, event) {
					if !yield(sub) {
						return
					}
				}
			}
		} else if hasKindSubs {
			for _, ssid := range kindSubs.Slice() {
				sub, ok := d.subscriptions.Load(ssid)
				if !ok {
					continue
				}

				if sub.filter.Authors != nil {
					// if there are any authors in the filter we already know this doesn't qualify
					continue
				}

				if filterMatchesTimestampConstraintsAndTags(sub.filter, event) {
					if !yield(sub) {
						return
					}
				}
			}
		}

		if len(event.Tags) > 0 {
			for _, ssid := range d.fallbackTags.Slice() {
				sub, ok := d.subscriptions.Load(ssid)
				if !ok {
					continue
				}

				if filterMatchesTimestampConstraintsAndTags(sub.filter, event) {
					if !yield(sub) {
						return
					}
				}
			}
		}

		for _, ssid := range d.fallbackNothing.Slice() {
			sub, ok := d.subscriptions.Load(ssid)
			if !ok {
				continue
			}

			if filterMatchesTimestampConstraints(sub.filter, event) {
				if !yield(sub) {
					return
				}
			}
		}
	}
}

//go:inline
func filterMatchesTimestampConstraints(filter nostr.Filter, event nostr.Event) bool {
	if filter.Since != 0 && event.CreatedAt < filter.Since {
		return false
	}

	if filter.Until != 0 && event.CreatedAt > filter.Until {
		return false
	}

	return true
}

//go:inline
func filterMatchesTimestampConstraintsAndTags(filter nostr.Filter, event nostr.Event) bool {
	if !filterMatchesTimestampConstraints(filter, event) {
		return false
	}

	for f, v := range filter.Tags {
		if !event.Tags.ContainsAny(f, v) {
			return false
		}
	}

	return true
}

//go:inline
func tagKeyValueKey(tagKey, tagValue string) string {
	return tagKey + "\x00" + tagValue
}

func (rl *Relay) GetListeningFilters() []nostr.Filter {
	rl.clientsMutex.Lock()
	defer rl.clientsMutex.Unlock()
	respfilters := make([]nostr.Filter, 0, rl.dispatcher.subscriptions.Size())
	for _, sub := range rl.dispatcher.subscriptions.Range {
		respfilters = append(respfilters, sub.filter)
	}
	return respfilters
}

// addListener may be called multiple times for each id and ws -- in which case each filter will
// be added as an independent listener
func (rl *Relay) addListener(
	ws *WebSocket,
	id string,
	filter nostr.Filter,
	cancel context.CancelCauseFunc,
) bool {
	select {
	case <-rl.clientsMutex.C():
		defer rl.clientsMutex.Unlock()
	case <-ws.Context.Done():
		return false
	}

	if specs, ok := rl.clients[ws]; ok /* this will always be true unless client has disconnected very rapidly */ {
		if len(specs) >= 16 || rl.dispatcher.subscriptions.Size() >= 1024 {
			return false
		}
		ssid := rl.dispatcher.addSubscription(subscription{
			ws:     ws,
			id:     id,
			filter: filter,
		})
		rl.clients[ws] = append(specs, listenerSpec{
			ssid:   ssid,
			cancel: cancel,
			sid:    id,
		})

		if rl.OnListenerAdded != nil {
			rl.OnListenerAdded(ws, ssid, id, filter)
		}
		return true
	}
	return false
}

// remove a specific subscription id from listeners for a given ws client
// and cancel its specific context
func (rl *Relay) removeListenerId(ws *WebSocket, id string) {
	rl.clientsMutex.Lock()
	defer rl.clientsMutex.Unlock()

	if specs, ok := rl.clients[ws]; ok {
		kept := specs[:0]
		for _, spec := range specs {
			if spec.sid == id {
				spec.cancel(ErrSubscriptionClosedByClient)
				filter := rl.dispatcher.removeSubscription(spec.ssid)

				if rl.OnListenerRemoved != nil {
					rl.OnListenerRemoved(ws, spec.ssid, id, filter)
				}

				continue
			}
			kept = append(kept, spec)
		}
		rl.clients[ws] = kept
	}
}

func (rl *Relay) removeClientAndListeners(ws *WebSocket) {
	rl.clientsMutex.Lock()
	defer rl.clientsMutex.Unlock()
	if specs, ok := rl.clients[ws]; ok {
		for _, spec := range specs {
			// no need to cancel contexts since they inherit from the main connection context
			filter := rl.dispatcher.removeSubscription(spec.ssid)

			if rl.OnListenerRemoved != nil {
				rl.OnListenerRemoved(ws, spec.ssid, spec.sid, filter)
			}
		}
	}
	delete(rl.clients, ws)
}

// returns how many listeners were notified
func (rl *Relay) notifyListeners(event nostr.Event, skipPrevent bool) int {
	count := 0
	rl.clientsMutex.Lock()
	snapshot := make([]subscription, 0, rl.dispatcher.subscriptions.Size())
	for _, sub := range rl.dispatcher.subscriptions.Range {
		snapshot = append(snapshot, sub)
	}
	rl.clientsMutex.Unlock()
listenersloop:
	for _, sub := range snapshot {
		if !sub.filter.Matches(event) {
			continue
		}
		if !skipPrevent && nil != rl.PreventBroadcast {
			if rl.PreventBroadcast(sub.ws, sub.filter, event) {
				continue listenersloop
			}
		}
		sub.ws.WriteJSON(nostr.EventEnvelope{SubscriptionID: &sub.id, Event: event})
		count++
	}
	return count
}
