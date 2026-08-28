package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip19"
)

// MentionMonitor watches for mentions of the relay pubkey and handles promotional requests
type MentionMonitor struct {
	relayPubkey string
	relaySeckey string
	storage     *Storage
	fetcher     *PostFetcher
	pool        *nostr.SimplePool
}

// NewMentionMonitor creates a new mention monitor
func NewMentionMonitor(relayPubkey, relaySeckey string, storage *Storage, fetcher *PostFetcher, pool *nostr.SimplePool) *MentionMonitor {
	return &MentionMonitor{
		relayPubkey: relayPubkey,
		relaySeckey: relaySeckey,
		storage:     storage,
		fetcher:     fetcher,
		pool:        pool,
	}
}

// Start begins monitoring for mentions
func (mm *MentionMonitor) Start(ctx context.Context, relays []string) {
	log.Printf("Starting mention monitor for pubkey %s", mm.relayPubkey)

	// Subscribe to kind:1 events that mention our relay
	since := nostr.Timestamp(time.Now().Unix())
	filter := nostr.Filter{
		Kinds: []int{1},
		Tags:  nostr.TagMap{"p": []string{mm.relayPubkey}},
		Since: &since,
	}

	sub := mm.pool.SubMany(ctx, relays, []nostr.Filter{filter})

	go func() {
		for event := range sub {
			// Process mention
			if err := mm.ProcessMention(ctx, event.Event); err != nil {
				log.Printf("Failed to process mention from %s: %v", event.PubKey, err)
			}
		}
	}()

	log.Printf("Mention monitor started, watching %d relays", len(relays))
}

// ProcessMention handles a mention event
func (mm *MentionMonitor) ProcessMention(ctx context.Context, mentionEvent *nostr.Event) error {
	// Check if already processed
	if mm.storage.IsMentionProcessed(mentionEvent.ID) {
		return nil
	}

	log.Printf("Processing mention from %s: %s", mentionEvent.PubKey[:8], mentionEvent.Content[:min(50, len(mentionEvent.Content))])

	// Extract note ID from content
	noteID := extractEventIDFromText(mentionEvent.Content)

	if noteID == "" {
		// No valid note ID found, send usage instructions
		log.Printf("No valid note ID in mention %s, sending usage instructions", mentionEvent.ID)
		return mm.SendUsageInstructions(ctx, mentionEvent)
	}

	// Normalize the note ID
	noteID = normalizeEventID(noteID)

	// Validate note ID format
	if len(noteID) != 64 {
		log.Printf("Invalid note ID format in mention %s: %s", mentionEvent.ID, noteID)
		return mm.SendUsageInstructions(ctx, mentionEvent)
	}

	// Fetch the note to validate it exists
	log.Printf("Fetching note %s to validate...", noteID[:8])
	noteToPromote, err := mm.fetcher.FetchPost(ctx, noteID)
	if err != nil {
		log.Printf("Failed to fetch note %s: %v", noteID, err)
		return mm.SendErrorReply(ctx, mentionEvent, fmt.Sprintf("Could not find note %s. Please check the note ID.", noteID[:16]))
	}

	// Verify it's a kind:1 event
	if noteToPromote.Kind != 1 {
		return mm.SendErrorReply(ctx, mentionEvent, "Only text notes (kind:1) can be promoted.")
	}

	// Create promotional reply
	if err := mm.CreatePromotionalReply(ctx, mentionEvent, noteToPromote); err != nil {
		return fmt.Errorf("failed to create promotional reply: %w", err)
	}

	// Mark mention as processed
	return mm.storage.MarkMentionProcessed(mentionEvent.ID)
}

// CreatePromotionalReply creates a confirmation note with note preview
func (mm *MentionMonitor) CreatePromotionalReply(ctx context.Context, mentionEvent *nostr.Event, noteToPromote *nostr.Event) error {
	// Get author info
	authorPubkey := noteToPromote.PubKey

	// Truncate content if too long
	content := noteToPromote.Content
	const maxContentLength = 280
	if len(content) > maxContentLength {
		content = content[:maxContentLength] + "..."
	}

	// Build promotional reply content
	replyContent := fmt.Sprintf(`🚀 Promotion Request

You're about to promote this note:

Author: nostr:%s
Content: %s

💰 Zap this note with any amount to add it to the relay!

The more sats you zap, the higher it will rank. Anyone can add more sats to boost the ranking.`,
		mustEncodeBech32NProfile(authorPubkey),
		content,
	)

	// Create the reply event
	replyEvent := nostr.Event{
		PubKey:    mm.relayPubkey,
		CreatedAt: nostr.Timestamp(time.Now().Unix()),
		Kind:      1,
		Tags: nostr.Tags{
			{"e", mentionEvent.ID, "", "root"},
			{"p", mentionEvent.PubKey},
			{"promoted_note", noteToPromote.ID}, // Custom tag to store which note this promotes
		},
		Content: replyContent,
	}

	// Sign the event
	if err := replyEvent.Sign(mm.relaySeckey); err != nil {
		return fmt.Errorf("failed to sign reply: %w", err)
	}

	// Publish to relays
	relays := mm.fetcher.Relays()
	log.Printf("Publishing promotional reply %s for note %s", replyEvent.ID[:8], noteToPromote.ID[:8])

	for _, relay := range relays {
		pub, err := mm.pool.EnsureRelay(relay)
		if err != nil {
			log.Printf("Failed to connect to relay %s: %v", relay, err)
			continue
		}

		if err := pub.Publish(ctx, replyEvent); err != nil {
			log.Printf("Failed to publish to %s: %v", relay, err)
		} else {
			log.Printf("Published promotional reply to %s", relay)
		}
	}

	// Store the mapping: promotional reply ID -> note to promote ID
	if err := mm.storage.AddPromotionalReply(replyEvent.ID, noteToPromote.ID); err != nil {
		return fmt.Errorf("failed to store promotional reply mapping: %w", err)
	}

	log.Printf("Created promotional reply %s for note %s", replyEvent.ID[:8], noteToPromote.ID[:8])
	return nil
}

// SendUsageInstructions sends a reply with usage instructions
func (mm *MentionMonitor) SendUsageInstructions(ctx context.Context, mentionEvent *nostr.Event) error {
	instructionsContent := `📢 Promotion Board

To promote a note, mention me with any valid note ID:

Examples:
• @relay promote note1abc...
• @relay check out nostr:nevent1...
• @relay bech32abc123...

I'll reply with a confirmation. Zap that reply with any amount to add the note to the promotion board!

The more sats, the higher the ranking. Anyone can boost any note!`

	replyEvent := nostr.Event{
		PubKey:    mm.relayPubkey,
		CreatedAt: nostr.Timestamp(time.Now().Unix()),
		Kind:      1,
		Tags: nostr.Tags{
			{"e", mentionEvent.ID, "", "root"},
			{"p", mentionEvent.PubKey},
		},
		Content: instructionsContent,
	}

	if err := replyEvent.Sign(mm.relaySeckey); err != nil {
		return fmt.Errorf("failed to sign instructions: %w", err)
	}

	// Publish to relays
	relays := mm.fetcher.Relays()
	for _, relay := range relays {
		pub, err := mm.pool.EnsureRelay(relay)
		if err != nil {
			continue
		}
		pub.Publish(ctx, replyEvent)
	}

	// Mark as processed so we don't spam
	return mm.storage.MarkMentionProcessed(mentionEvent.ID)
}

// SendErrorReply sends an error message reply
func (mm *MentionMonitor) SendErrorReply(ctx context.Context, mentionEvent *nostr.Event, errorMsg string) error {
	replyContent := fmt.Sprintf("❌ %s", errorMsg)

	replyEvent := nostr.Event{
		PubKey:    mm.relayPubkey,
		CreatedAt: nostr.Timestamp(time.Now().Unix()),
		Kind:      1,
		Tags: nostr.Tags{
			{"e", mentionEvent.ID, "", "root"},
			{"p", mentionEvent.PubKey},
		},
		Content: replyContent,
	}

	if err := replyEvent.Sign(mm.relaySeckey); err != nil {
		return fmt.Errorf("failed to sign error reply: %w", err)
	}

	// Publish to relays
	relays := mm.fetcher.Relays()
	for _, relay := range relays {
		pub, err := mm.pool.EnsureRelay(relay)
		if err != nil {
			continue
		}
		pub.Publish(ctx, replyEvent)
	}

	// Mark as processed
	return mm.storage.MarkMentionProcessed(mentionEvent.ID)
}

// mustEncodeBech32NProfile encodes a pubkey as npub
func mustEncodeBech32NProfile(pubkey string) string {
	// For simplicity, just return npub for now
	// Full nprofile would include relay hints
	npub, err := nip19.EncodePublicKey(pubkey)
	if err != nil {
		return pubkey
	}
	return npub
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
