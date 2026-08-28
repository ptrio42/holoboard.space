package main

import (
	"context"
	"fmt"
	"log"

	"github.com/fiatjaf/khatru"
	"github.com/nbd-wtf/go-nostr"
)

// RelayConfig holds the relay configuration
type RelayConfig struct {
	Name        string
	Description string
	RelayPubkey string
	Contact     string
	Icon        string
}

// SetupRelay configures the khatru relay with all handlers
func SetupRelay(relay *khatru.Relay, storage *Storage, monitor *PaymentMonitor, invoiceManager *InvoiceManager, config RelayConfig) {
	// Set relay metadata
	relay.Info.Name = config.Name
	relay.Info.Description = config.Description
	relay.Info.PubKey = config.RelayPubkey
	relay.Info.Contact = config.Contact
	relay.Info.Icon = config.Icon

	// Supported NIPs
	// khatru appends 9 itself whenever a DeleteEvent hook is registered
	// (nip11.go:13), and it does not deduplicate, so listing it here served the
	// document with 9 in it twice.
	relay.Info.SupportedNIPs = []int{1, 11, 57}

	// RejectEvent: Accept kind:1 (posts) and kind:9735 (zap receipts)
	relay.RejectEvent = append(relay.RejectEvent, func(ctx context.Context, event *nostr.Event) (bool, string) {
		// Accept zap receipts (for payment processing)
		if event.Kind == 9735 {
			return false, ""
		}

		// Only accept kind:1 events for storage
		if event.Kind != 1 {
			return true, "relay only accepts kind:1 events and kind:9735 zap receipts"
		}

		// Check if this event has already been paid for
		if !storage.HasPost(event.ID) {
			return true, "event must be paid for before submission (send zap with 'e' tag or use PROMOTE flow)"
		}

		return false, ""
	})

	// QueryEvents: Return only paid posts, sorted by payment ranking
	relay.QueryEvents = append(relay.QueryEvents, func(ctx context.Context, filter nostr.Filter) (chan *nostr.Event, error) {
		// Query paid posts from storage
		events := storage.QueryPosts(ctx, filter)

		// Create a channel and send events
		ch := make(chan *nostr.Event)
		go func() {
			defer close(ch)
			for _, event := range events {
				select {
				case <-ctx.Done():
					return
				case ch <- event:
				}
			}
		}()

		return ch, nil
	})

	// StoreEvent: Store events (but RejectEvent already filters out unpaid ones)
	relay.StoreEvent = append(relay.StoreEvent, func(ctx context.Context, event *nostr.Event) error {
		// Don't store zap receipts (they're processed in OnEventSaved)
		if event.Kind == 9735 {
			log.Printf("Zap receipt %s received, will process", event.ID)
			return nil
		}

		// At this point, the event has passed RejectEvent, so it's already paid for
		// The event is stored in memory by khatru, we already have it in our storage
		log.Printf("Event %s accepted (already paid)", event.ID)
		return nil
	})

	// DeleteEvent: Optionally handle deletion requests
	relay.DeleteEvent = append(relay.DeleteEvent, func(ctx context.Context, event *nostr.Event) error {
		// For now, we don't allow deletion of paid posts
		// Could implement removal if original author requests it
		return fmt.Errorf("deletion not supported for promoted posts")
	})

	// OnEventSaved: Handle events after they're saved (for side effects)
	relay.OnEventSaved = append(relay.OnEventSaved, func(ctx context.Context, event *nostr.Event) {
		// Process zaps directed to our relay
		if event.Kind == 9735 { // Zap receipt
			if err := ValidateZapEvent(event); err != nil {
				log.Printf("Invalid zap event: %v", err)
				return
			}

			if err := monitor.ProcessZap(ctx, event); err != nil {
				log.Printf("Failed to process zap: %v", err)
			}
		}

	})

	log.Printf("Relay configured: %s", config.Name)
	log.Printf("Relay pubkey: %s", config.RelayPubkey)
	log.Printf("Total promoted posts: %d", storage.CountPosts())
}

// CreateInfoEvent creates an informational event explaining how to use the relay
func CreateInfoEvent(relayPubkey, relayPrivkey string) (*nostr.Event, error) {
	content := `🚀 Welcome to the Nostr Promotion Board!

This is a paid promotion relay where posts are ranked by total sats received.

📍 How to promote a post:

**Method 1: Zap with event reference (recommended)**
Send a zap to this relay's pubkey and include the post reference in the zap comment/message field.

Relay pubkey: ` + relayPubkey + `

Supported formats in zap comment:
- nostr:nevent1... (most common)
- nostr:note1...
- nevent1...
- note1...
- 64-char hex ID

The relay monitors major relays for zaps and will automatically fetch and promote the post!

**Method 2: PROMOTE command**
1. Send a DM to the relay with: PROMOTE <post_id>
   (Supports all formats above)
2. The relay will reply with a Lightning invoice
3. Pay the invoice
4. Your post will be promoted!

💰 Payment Rules:
- Any post can be promoted by anyone (not just the author)
- Posts are ranked by total sats paid
- Multiple payments to the same post increase its ranking
- The relay actively monitors other relays for zaps

📊 Query this relay to see the top promoted posts!

This relay only stores and serves posts that have been paid for.
`

	event := &nostr.Event{
		PubKey:    relayPubkey,
		CreatedAt: nostr.Now(),
		Kind:      1,
		Tags:      nostr.Tags{},
		Content:   content,
	}

	// Sign the event
	if err := event.Sign(relayPrivkey); err != nil {
		return nil, fmt.Errorf("failed to sign info event: %w", err)
	}

	return event, nil
}
