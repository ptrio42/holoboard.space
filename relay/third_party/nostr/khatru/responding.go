package khatru

import (
	"context"

	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/nip45/hyperloglog"
)

func (rl *Relay) handleRequest(ctx context.Context, id string, ws *WebSocket, filter nostr.Filter) error {

	if filter.LimitZero {
		// don't do any queries, just subscribe to future events
		return nil
	}

	// run the function to query events
	if nil != rl.QueryStored {
		for event := range rl.QueryStored(ctx, filter) {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if nil != ws.WriteJSON(nostr.EventEnvelope{SubscriptionID: &id, Event: event}) {
				break
			}
		}
	}

	return nil
}

func (rl *Relay) handleCountRequest(ctx context.Context, ws *WebSocket, filter nostr.Filter) uint32 {
	// check if we'll reject this filter
	if nil != rl.OnCount {
		if rejecting, msg := rl.OnCount(ctx, filter); rejecting {
			ws.WriteJSON(nostr.NoticeEnvelope(msg))
			return 0
		}
	}

	// run the functions to count (generally it will be just one)
	if nil != rl.Count {
		res, err := rl.Count(ctx, filter)
		if err != nil {
			ws.WriteJSON(nostr.NoticeEnvelope(err.Error()))
		}
		return res
	}

	return 0
}

func (rl *Relay) handleCountRequestWithHLL(
	ctx context.Context,
	ws *WebSocket,
	filter nostr.Filter,
	offset int,
) (uint32, *hyperloglog.HyperLogLog) {
	// check if we'll reject this filter
	if nil != rl.OnCount {
		if rejecting, msg := rl.OnCount(ctx, filter); rejecting {
			ws.WriteJSON(nostr.NoticeEnvelope(msg))
			return 0, nil
		}
	}

	if nil != rl.CountHLL {
		res, hll, err := rl.CountHLL(ctx, filter, offset)
		if err != nil {
			ws.WriteJSON(nostr.NoticeEnvelope(err.Error()))
		}
		return res, hll
	}

	return 0, nil
}
