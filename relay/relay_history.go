package main

import (
	"context"
	"fmt"
	"log"
	"math"
	"time"

	"fiatjaf.com/nostr"
)

var backfillSlots = make(chan struct{}, 4)

// Backfill a bounded monitor window without treating a full first page as
// complete. Inclusive boundaries retain timestamp ties; saturation is explicit.
func backfillRelay(ctx context.Context, relay *nostr.Relay, filter nostr.Filter, emit func(context.Context, *nostr.Event) error) {
	select {
	case backfillSlots <- struct{}{}:
	default:
		log.Printf("Nostr backlog incomplete on %s: backfill budget exhausted", relay.URL)
		return
	}
	defer func() { <-backfillSlots }()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	stop := context.AfterFunc(relay.Context(), cancel)
	defer stop()
	filter.Limit = 100
	seen := map[string]bool{}
	var previous nostr.Timestamp = -1
	for page := 0; page < 32 && len(seen) < 4096; page++ {
		events, err := relay.QuerySync(ctx, filter)
		var oldest nostr.Timestamp = math.MaxInt64
		added := 0
		for _, event := range events {
			if event.CreatedAt < oldest {
				oldest = event.CreatedAt
			}
			if seen[event.ID.Hex()] {
				continue
			}
			if len(seen) >= 4096 {
				log.Printf("Nostr backlog incomplete on %s: event budget exhausted", relay.URL)
				return
			}
			seen[event.ID.Hex()] = true
			added++
			if err := emit(ctx, event); err != nil {
				log.Printf("Nostr backlog processing paused on %s: %v", relay.URL, err)
				return
			}
		}
		if err != nil {
			log.Printf("Nostr backlog incomplete on %s: %v", relay.URL, err)
			return
		}
		if len(events) < filter.Limit {
			return
		}
		if oldest == previous && added == 0 {
			if filter.Limit >= 512 {
				log.Printf("Nostr backlog incomplete on %s: saturated timestamp %d", relay.URL, oldest)
				return
			}
			filter.Limit = min(512, filter.Limit*2)
		}
		previous = oldest
		until := oldest
		filter.Until = until
	}
	log.Printf("Nostr backlog incomplete on %s: page or event budget exhausted", relay.URL)
}

func sendBackfillEvent(out chan<- *nostr.Event) func(context.Context, *nostr.Event) error {
	return func(ctx context.Context, event *nostr.Event) error {
		select {
		case out <- event:
			return nil
		case <-ctx.Done():
			return fmt.Errorf("backfill delivery: %w", ctx.Err())
		}
	}
}
