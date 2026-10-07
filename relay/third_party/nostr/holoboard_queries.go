package nostr

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// SubscribeFilters retains NIP-01 multiple-filter requests on one subscription.
// The upstream convenience API exposes only a single filter.
func (r *Relay) SubscribeFilters(ctx context.Context, filters []Filter) (*Subscription, error) {
	if !r.IsConnected() {
		return nil, ErrDisconnected
	}
	if len(filters) == 0 || len(filters) > 8 {
		return nil, errors.New("invalid filter count")
	}
	sub := r.prepareSubscription(ctx, filters, SubscriptionOptions{}, false)
	if err := sub.Fire(); err != nil {
		sub.cancel(err)
		sub.Unsub()
		return nil, err
	}
	return sub, nil
}

// QuerySync preserves partial results and distinguishes local timeouts from EOSE.
func (r *Relay) QuerySync(ctx context.Context, filter Filter) ([]*Event, error) {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 7*time.Second)
		defer cancel()
	}
	sub, err := r.Subscribe(ctx, filter, SubscriptionOptions{})
	if err != nil {
		return nil, err
	}
	defer sub.Unsub()
	events := make([]*Event, 0)
	bytes := 0
	complete := func(err error) ([]*Event, error) {
		select {
		case <-sub.EndOfStoredEvents:
			return events, nil
		default:
		}
		return events, err
	}
	for {
		select {
		case event, ok := <-sub.Events:
			if !ok {
				return complete(context.Cause(sub.Context))
			}
			encoded, err := event.MarshalJSON()
			if err != nil {
				return events, err
			}
			bytes += len(encoded)
			if len(events) >= 512 || bytes > 4<<20 {
				return events, errors.New("query retention budget exceeded")
			}
			events = append(events, &event)
		case <-sub.EndOfStoredEvents:
			return events, nil
		case reason := <-sub.ClosedReason:
			return complete(fmt.Errorf("relay closed query: %s", reason))
		case <-ctx.Done():
			return complete(ctx.Err())
		case <-sub.Context.Done():
			return complete(context.Cause(sub.Context))
		}
	}
}
