package main

import (
	"context"
	"fmt"
	"log"

	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip04"
)

// DMMonitor monitors external relays for DMs sent to the relay
type DMMonitor struct {
	relays         []string
	relayPubkey    string
	relayPrivkey   string
	invoiceManager *InvoiceManager
	storage        *Storage // Use persistent storage for DM tracking
}

// NewDMMonitor creates a new DM monitor
func NewDMMonitor(relays []string, relayPubkey, relayPrivkey string, invoiceManager *InvoiceManager, storage *Storage) *DMMonitor {
	return &DMMonitor{
		relays:         relays,
		relayPubkey:    relayPubkey,
		relayPrivkey:   relayPrivkey,
		invoiceManager: invoiceManager,
		storage:        storage,
	}
}

// Start begins monitoring for DMs
func (dm *DMMonitor) Start(ctx context.Context) error {
	log.Printf("Starting DM monitor on %d relays", len(dm.relays))

	// Subscribe to DMs (kind 4) sent to our relay pubkey
	filters := []nostr.Filter{
		{
			Kinds: []int{4}, // Encrypted DMs
			Tags: nostr.TagMap{
				"p": []string{dm.relayPubkey}, // DMs to our relay
			},
			Limit: 100, // Get recent DMs
		},
	}

	// Connect to relays and subscribe
	pool := nostr.NewSimplePool(ctx)

	// Subscribe to events
	sub := pool.SubMany(ctx, dm.relays, filters)

	go func() {
		for event := range sub {
			// Check if already processed using persistent storage
			if dm.storage.IsDMProcessed(event.ID) {
				continue // Already processed
			}

			log.Printf("Received DM from %s (event ID: %s)", event.PubKey, event.ID)

			// Process the DM
			if err := dm.processDM(ctx, event.Event); err != nil {
				log.Printf("Failed to process DM: %v", err)
				continue
			}

			// Mark as processed in persistent storage
			if err := dm.storage.MarkDMProcessed(event.ID); err != nil {
				log.Printf("Failed to mark DM as processed: %v", err)
			}
		}
	}()

	log.Printf("DM monitor started, listening for PROMOTE commands")
	return nil
}

// processDM decrypts and processes a DM
func (dm *DMMonitor) processDM(ctx context.Context, event *nostr.Event) error {
	// Decrypt the content using NIP-04
	senderPubkey := event.PubKey

	// Compute shared secret between our privkey and sender's pubkey
	sharedSecret, err := nip04.ComputeSharedSecret(senderPubkey, dm.relayPrivkey)
	if err != nil {
		return fmt.Errorf("failed to compute shared secret: %w", err)
	}

	// Decrypt using the shared secret
	decrypted, err := nip04.Decrypt(event.Content, sharedSecret)
	if err != nil {
		return fmt.Errorf("failed to decrypt DM: %w", err)
	}

	log.Printf("Decrypted DM content: %s", decrypted)

	// Parse the PROMOTE command
	postID, amountSats, ok := ParsePromoteCommand(decrypted)
	if !ok {
		log.Printf("Not a valid PROMOTE command, ignoring")
		return nil
	}

	// Use specified amount or default
	amount := amountSats
	if amount == 0 {
		amount = dm.invoiceManager.defaultAmountSats
	}

	log.Printf("PROMOTE request from %s for post %s (amount: %d sats)", senderPubkey, postID, amount)

	// Generate a Lightning invoice
	invoice, err := dm.invoiceManager.GeneratePromotionInvoice(ctx, postID, amount)
	if err != nil {
		log.Printf("Failed to generate invoice: %v", err)
		return err
	}

	log.Printf("Generated invoice for post %s (payment_hash: %s, amount: %d sats)", postID, invoice.PaymentHash, invoice.AmountSats)

	// Send reply DM with the invoice
	if err := dm.sendReplyDM(ctx, senderPubkey, invoice); err != nil {
		log.Printf("Failed to send reply DM: %v", err)
		return err
	}

	return nil
}

// sendReplyDM sends an encrypted reply DM with the invoice
func (dm *DMMonitor) sendReplyDM(ctx context.Context, recipientPubkey string, invoice *Invoice) error {
	// Format the reply message
	message := fmt.Sprintf(`Invoice generated!

Amount: %d sats
Expires: %s

Payment Request:
%s

Pay this invoice to promote your post. Once paid, your post will be added to the relay.`,
		invoice.AmountSats,
		invoice.ExpiresAt.Format("2006-01-02 15:04:05"),
		invoice.PaymentRequest,
	)

	// Encrypt the message using NIP-04
	// Compute shared secret between our privkey and recipient's pubkey
	sharedSecret, err := nip04.ComputeSharedSecret(recipientPubkey, dm.relayPrivkey)
	if err != nil {
		return fmt.Errorf("failed to compute shared secret: %w", err)
	}

	encrypted, err := nip04.Encrypt(message, sharedSecret)
	if err != nil {
		return fmt.Errorf("failed to encrypt reply: %w", err)
	}

	// Create the DM event
	event := &nostr.Event{
		PubKey:    dm.relayPubkey,
		CreatedAt: nostr.Now(),
		Kind:      4, // Encrypted DM
		Tags: nostr.Tags{
			nostr.Tag{"p", recipientPubkey},
		},
		Content: encrypted,
	}

	// Sign the event
	if err := event.Sign(dm.relayPrivkey); err != nil {
		return fmt.Errorf("failed to sign event: %w", err)
	}

	// Publish to relays
	pool := nostr.NewSimplePool(ctx)

	successes := 0
	for _, relayURL := range dm.relays {
		relay, err := pool.EnsureRelay(relayURL)
		if err != nil {
			log.Printf("Failed to connect to relay %s: %v", relayURL, err)
			continue
		}

		if err := relay.Publish(ctx, *event); err != nil {
			log.Printf("Failed to publish reply DM to %s: %v", relayURL, err)
		} else {
			successes++
			log.Printf("Reply DM sent to %s via %s", recipientPubkey, relayURL)
		}
	}

	if successes == 0 {
		return fmt.Errorf("failed to publish reply DM to any relay")
	}

	log.Printf("Reply DM successfully sent to %s (%d/%d relays)", recipientPubkey, successes, len(dm.relays))
	return nil
}
