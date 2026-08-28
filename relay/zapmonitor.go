package main

import (
	"context"
	"log"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// ZapMonitor listens to external relays for zaps directed to our relay
type ZapMonitor struct {
	relays         []string
	relayPubkey    string
	paymentMonitor *PaymentMonitor
}

// NewZapMonitor creates a new zap monitor
func NewZapMonitor(relays []string, relayPubkey string, paymentMonitor *PaymentMonitor) *ZapMonitor {
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
	filter := nostr.Filter{
		Kinds: []int{9735}, // Zap receipts
		Tags: nostr.TagMap{
			"p": []string{zm.relayPubkey}, // Zaps directed to us
		},
		Limit: 100,
	}

	// Start monitoring each relay
	for _, relayURL := range zm.relays {
		go zm.monitorRelay(ctx, relayURL, filter)
	}

	return nil
}

// monitorRelay connects to a relay and listens for zaps
func (zm *ZapMonitor) monitorRelay(ctx context.Context, relayURL string, filter nostr.Filter) {
	log.Printf("Monitoring relay for zaps: %s", relayURL)

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Connect to relay
		relay, err := nostr.RelayConnect(ctx, relayURL)
		if err != nil {
			log.Printf("Failed to connect to relay %s: %v (retrying in 30s)", relayURL, err)
			time.Sleep(30 * time.Second)
			continue
		}

		log.Printf("Connected to %s, subscribing to zaps", relayURL)

		// Subscribe to zaps
		sub, err := relay.Subscribe(ctx, []nostr.Filter{filter})
		if err != nil {
			log.Printf("Failed to subscribe to %s: %v", relayURL, err)
			relay.Close()
			time.Sleep(30 * time.Second)
			continue
		}

		// Process events
		for {
			select {
			case <-ctx.Done():
				relay.Close()
				return
			case event := <-sub.Events:
				if event == nil {
					continue
				}

				log.Printf("Received zap receipt from %s: %s", relayURL, event.ID)

				// Validate and process the zap
				if err := ValidateZapEvent(event); err != nil {
					log.Printf("Invalid zap event from %s: %v", relayURL, err)
					continue
				}

				if err := zm.paymentMonitor.ProcessZap(ctx, event); err != nil {
					log.Printf("Failed to process zap from %s: %v", relayURL, err)
				} else {
					log.Printf("Successfully processed zap from %s", relayURL)
				}
			}
		}
	}
}
