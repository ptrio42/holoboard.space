package main

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// ZapMonitor listens to external relays for zaps directed to our relay
type ZapMonitor struct {
	runner         sync.WaitGroup
	relays         []string
	relayPubkey    string
	paymentMonitor *PaymentMonitor
}

// NewZapMonitor creates a new zap monitor
func NewZapMonitor(relays []string, relayPubkey string, paymentMonitor *PaymentMonitor) *ZapMonitor {
	trustConfiguredRelays(relays)
	return &ZapMonitor{
		relays:         relays,
		relayPubkey:    relayPubkey,
		paymentMonitor: paymentMonitor,
	}
}

// Start begins monitoring relays for zaps
func (zm *ZapMonitor) Start(ctx context.Context) error {
	log.Printf("Starting zap monitor for %d relays", len(zm.relays))

	// Create filter for zap receipts directed to our relay
	since := nostr.Timestamp(time.Now().Add(-30 * 24 * time.Hour).Unix())
	filter := nostr.Filter{
		Since: &since,
		Kinds: []int{9735}, // Zap receipts
		Tags: nostr.TagMap{
			"p": []string{zm.relayPubkey}, // Zaps directed to us
		},
		Limit: 100,
	}

	// Start monitoring each relay
	for _, relayURL := range zm.relays {
		zm.runner.Add(1)
		go func(url string) { defer zm.runner.Done(); zm.monitorRelay(ctx, url, filter) }(relayURL)
	}

	return nil
}

func (zm *ZapMonitor) Wait() { zm.runner.Wait() }

// monitorRelay connects to a relay and listens for zaps
func (zm *ZapMonitor) monitorRelay(ctx context.Context, relayURL string, filter nostr.Filter) {
	delay := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		zm.monitorConnection(ctx, relayURL, filter)
		if time.Since(started) > time.Minute {
			delay = time.Second
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if delay < 30*time.Second {
			delay *= 2
			if delay > 30*time.Second {
				delay = 30 * time.Second
			}
		}
	}
}

func (zm *ZapMonitor) monitorConnection(ctx context.Context, relayURL string, filter nostr.Filter) {
	relay, err := connectRelay(ctx, relayURL)
	if err != nil {
		log.Printf("Zap relay connection failed: %v", err)
		return
	}
	defer relay.Close()
	sub, err := relay.Subscribe(ctx, []nostr.Filter{filter})
	if err != nil {
		return
	}
	defer sub.Unsub()
	backfillCtx, stop := context.WithCancel(ctx)
	var backfill sync.WaitGroup
	defer func() { stop(); backfill.Wait() }()
	startedBackfill := false
	count := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-relay.Context().Done():
			return
		case <-sub.EndOfStoredEvents:
			if !startedBackfill && count >= filter.Limit {
				startedBackfill = true
				backfill.Add(1)
				go func() { defer backfill.Done(); backfillRelay(backfillCtx, relay, filter, zm.paymentMonitor.ProcessZap) }()
			}
			// EndOfStoredEvents is a buffered signal, not a recurring clock.
		case <-sub.ClosedReason:
			return
		case event, ok := <-sub.Events:
			if !ok {
				return
			}
			count++
			if event == nil {
				continue
			}
			if err := zm.paymentMonitor.ProcessZap(ctx, event); err != nil {
				log.Printf("Failed to process zap from %s: %v", relayURL, err)
			}
		}
	}
}
