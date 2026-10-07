package main

import (
	"context"
	"fmt"
	"iter"
	"log"

	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/khatru"
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
	if pubkey, err := nostr.PubKeyFromHexCheap(config.RelayPubkey); err == nil {
		relay.Info.PubKey = &pubkey
	}
	relay.Info.Contact = config.Contact
	relay.Info.Icon = config.Icon

	relay.Info.SupportedNIPs = []any{1, 11, 22, 57}
	relay.OnEvent = func(ctx context.Context, event nostr.Event) (bool, string) {
		if event.Kind == 9735 {
			return false, ""
		}
		if !isPromotable(event.Kind) {
			return true, "relay only accepts kind:1 notes, kind:1111 comments and kind:9735 zap receipts"
		}
		if !storage.HasPost(event.ID.Hex()) {
			return true, "event must be paid for before submission (send zap with 'e' tag or use PROMOTE flow)"
		}
		return false, ""
	}
	relay.QueryStored = func(ctx context.Context, filter nostr.Filter) iter.Seq[nostr.Event] {
		return func(yield func(nostr.Event) bool) {
			for _, event := range storage.QueryPosts(ctx, filter) {
				if ctx.Err() != nil || !yield(*event) {
					return
				}
			}
		}
	}
	relay.StoreEvent = func(ctx context.Context, event nostr.Event) error {
		if event.Kind == 9735 {
			log.Printf("Zap receipt %s received, will process", event.ID.Hex())
		} else {
			log.Printf("Event %s accepted (already paid)", event.ID.Hex())
		}
		return nil
	}
	relay.DeleteEvent = func(ctx context.Context, id nostr.ID) error {
		return fmt.Errorf("deletion not supported for promoted posts")
	}
	relay.OnEventSaved = func(ctx context.Context, event nostr.Event) {
		if event.Kind == 9735 {
			if err := monitor.ProcessZap(ctx, &event); err != nil {
				log.Printf("Failed to process zap: %v", err)
			}
		}
	}

	log.Printf("Relay configured: %s", config.Name)
	log.Printf("Relay pubkey: %s", config.RelayPubkey)
	log.Printf("Total promoted posts: %d", storage.CountPosts())
}

// CreateInfoEvent creates an informational event explaining how to use the relay
func CreateInfoEvent(relayPubkey, relayPrivkey string) (*nostr.Event, error) {
	content := `🚀 Welcome to the Nostr Promotion Board!

This is a paid promotion relay where posts are ranked by sats. Recent sats count for
more, so a post nobody pays for slides down the board over time.

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
- Posts are ranked by sats paid, each payment worth less as it ages
- Multiple payments to the same post increase its ranking, and keep it there
- The relay actively monitors other relays for zaps

📊 Query this relay to see the top promoted posts!

This relay only stores and serves posts that have been paid for.
`

	event := &nostr.Event{
		PubKey:    nostr.MustPubKeyFromHex(relayPubkey),
		CreatedAt: nostr.Now(),
		Kind:      1,
		Tags:      nostr.Tags{},
		Content:   content,
	}

	// Sign the event
	if err := signEvent(event, relayPrivkey); err != nil {
		return nil, fmt.Errorf("failed to sign info event: %w", err)
	}

	return event, nil
}
