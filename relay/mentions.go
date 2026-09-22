package main

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"time"

	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip19"
)

var publicPromoteCommand = regexp.MustCompile(`(?i)^\s*(?:(?:(?:nostr:)?(?:npub1|nprofile1)[023456789acdefghjklmnpqrstuvwxyz]+|@[^\s,:]+)[,:]?\s+)*promote(?:\s+((?:nostr:)?(?:note1|nevent1)[023456789acdefghjklmnpqrstuvwxyz]+|[0-9a-f]{64}))?\s*[.!]?\s*$`)

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

	// Resume from where the last run got to, so mentions sent during a restart
	// or a deploy are not silently dropped. Bounded, because a relay that was
	// off for a month should not wake up and replay a month of mentions at
	// everyone who wrote to it.
	since := nostr.Timestamp(mentionResumePoint(mm.storage.MentionWatermark(), time.Now()))
	filter := nostr.Filter{
		Kinds: []int{1},
		Tags:  nostr.TagMap{"p": []string{mm.relayPubkey}},
		Since: &since,
	}
	log.Printf("Mention monitor resuming from %s", time.Unix(int64(since), 0).Format(time.RFC3339))

	sub := mm.pool.SubMany(ctx, relays, []nostr.Filter{filter})

	go func() {
		for event := range sub {
			// Process mention
			if err := mm.ProcessMention(ctx, event.Event); err != nil {
				log.Printf("Failed to process mention from %s: %v", event.PubKey, err)
			}
			// Move the watermark even when handling failed. A mention that
			// cannot be processed now will not process any better on the next
			// restart, and leaving the watermark behind would replay it
			// forever.
			if err := mm.storage.AdvanceMentionWatermark(int64(event.CreatedAt)); err != nil {
				log.Printf("Failed to advance mention watermark: %v", err)
			}
		}
	}()

	log.Printf("Mention monitor started, watching %d relays", len(relays))
}

// parsePromotionCommand recognizes a complete public command after optional
// textual profile mentions. Matching the whole message matters: "promote" can
// occur in ordinary conversation, and a media URL can contain a 64-character
// hash that is not a Nostr event ID.
func parsePromotionCommand(mentionEvent *nostr.Event) (target string, command bool) {
	matches := publicPromoteCommand.FindStringSubmatch(mentionEvent.Content)
	if matches == nil {
		return "", false
	}
	if matches[1] != "" {
		return matches[1], true
	}
	return quotedEventID(mentionEvent), true
}

func mentionedNote(mentionEvent *nostr.Event) string {
	target, _ := parsePromotionCommand(mentionEvent)
	return target
}

// ProcessMention handles a mention event
func (mm *MentionMonitor) ProcessMention(ctx context.Context, mentionEvent *nostr.Event) error {
	// Check if already processed
	if mm.storage.IsMentionProcessed(mentionEvent.ID) {
		return nil
	}

	log.Printf("Processing mention from %s: %s", short(mentionEvent.PubKey, 8), short(mentionEvent.Content, 50))

	noteReference, isCommand := parsePromotionCommand(mentionEvent)
	if !isCommand {
		// Nothing to act on, so say nothing.
		//
		// Answering every mention turned the account into something that
		// interrupts: naming the board in a note, to recommend it or argue
		// about it, came back with instructions nobody asked for. Only the
		// explicit promote command signals that the author wants a response.
		log.Printf("Mention %s is not a promotion command, leaving it alone", short(mentionEvent.ID, 8))
		return mm.storage.MarkMentionProcessed(mentionEvent.ID)
	}

	if noteReference == "" {
		return mm.SendUsageInstructions(ctx, mentionEvent)
	}

	// Normalize the note ID
	noteID := normalizeEventID(noteReference)

	// Validate note ID format
	if len(noteID) != 64 {
		log.Printf("Invalid note ID format in mention %s: %s", mentionEvent.ID, noteID)
		return mm.SendUsageInstructions(ctx, mentionEvent)
	}

	// Fetch the note to validate it exists
	log.Printf("Fetching note %s to validate...", short(noteID, 8))
	hints, author := noteHints(noteReference)
	noteToPromote, err := mm.fetcher.FetchPostFrom(ctx, noteID, hints, author)
	if err != nil {
		log.Printf("Failed to fetch note %s: %v", noteID, err)
		return mm.SendErrorReply(ctx, mentionEvent, fmt.Sprintf("Could not find note %s. Please check the note ID.", short(noteID, 16)))
	}

	// Verify it's a kind:1 event
	if !isPromotable(noteToPromote.Kind) {
		return mm.SendErrorReply(ctx, mentionEvent, "Only text notes (kind:1) can be promoted.")
	}

	// Create promotional reply
	if err := mm.CreatePromotionalReply(ctx, mentionEvent, noteToPromote); err != nil {
		return fmt.Errorf("failed to create promotional reply: %w", err)
	}

	// Mark mention as processed
	return mm.storage.MarkMentionProcessed(mentionEvent.ID)
}

const promotionalReplyCopy = `🚀 Promote on Holoboard

Zap this Holoboard reply to promote the quoted note.
More sats move the quoted note higher. Anyone can boost it.`

// buildPromotionalReply keeps the payment target and the promoted note visually
// distinct. The outer event receives the zap; the NIP-18 quote remains the
// original, signed event and gives clients a native preview and link.
func (mm *MentionMonitor) buildPromotionalReply(mentionEvent *nostr.Event, noteToPromote *nostr.Event) (nostr.Event, error) {
	relays := mm.fetcher.Relays()
	reference, err := nip19.EncodeEvent(noteToPromote.ID, relays, noteToPromote.PubKey)
	if err != nil {
		return nostr.Event{}, fmt.Errorf("encode promoted note reference: %w", err)
	}

	relayHint := ""
	if len(relays) > 0 {
		relayHint = relays[0]
	}

	return nostr.Event{
		PubKey:    mm.relayPubkey,
		CreatedAt: nostr.Timestamp(time.Now().Unix()),
		Kind:      1,
		Tags: nostr.Tags{
			{"e", mentionEvent.ID, "", "root"},
			{"p", mentionEvent.PubKey},
			{"q", noteToPromote.ID, relayHint, noteToPromote.PubKey},
			{"promoted_note", noteToPromote.ID},
		},
		Content: promotionalReplyCopy + "\n\nnostr:" + reference,
	}, nil
}

// CreatePromotionalReply creates a confirmation note with a native quote.
func (mm *MentionMonitor) CreatePromotionalReply(ctx context.Context, mentionEvent *nostr.Event, noteToPromote *nostr.Event) error {
	replyEvent, err := mm.buildPromotionalReply(mentionEvent, noteToPromote)
	if err != nil {
		return err
	}

	// Sign the event
	if err := replyEvent.Sign(mm.relaySeckey); err != nil {
		return fmt.Errorf("failed to sign reply: %w", err)
	}

	// Publish to relays
	relays := mm.fetcher.Relays()
	log.Printf("Publishing promotional reply %s for note %s", short(replyEvent.ID, 8), short(noteToPromote.ID, 8))

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

	log.Printf("Created promotional reply %s for note %s", short(replyEvent.ID, 8), short(noteToPromote.ID, 8))
	return nil
}

// SendUsageInstructions sends a reply with usage instructions
func (mm *MentionMonitor) SendUsageInstructions(ctx context.Context, mentionEvent *nostr.Event) error {
	instructionsContent := `📢 Promotion Board

To promote a note, mention me with one of these commands:

Examples:
• @relay promote note1abc...
• @relay promote nostr:nevent1...
• Quote a note and write: @relay promote

I'll reply with the note quoted. Zap that Holoboard reply with any amount to promote the quoted note on the board!

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

// maxMentionBacklog caps how far back a restart will look for missed mentions.
const maxMentionBacklog = 24 * time.Hour

// resumePoint picks where a subscription should start: the stored watermark,
// unless it is missing or so old that resuming from it would replay a flood.
//
// Every monitor that answers people needs this. Subscribing from now silently
// drops whatever arrived during a restart; subscribing from the beginning
// answers months of history all over again, which is exactly what the DM
// monitor did on its first deploy.
func resumePoint(watermark int64, now time.Time, maxBacklog time.Duration) int64 {
	floor := now.Add(-maxBacklog).Unix()
	if watermark <= 0 || watermark < floor {
		return floor
	}
	return watermark
}

func mentionResumePoint(watermark int64, now time.Time) int64 {
	return resumePoint(watermark, now, maxMentionBacklog)
}

// quotedEventID reads the NIP-18 quote tag.
//
// With an explicit promote command, quoting a note and tagging the relay is a
// concise way to identify the target. Most clients also drop a nostr:nevent1
// into the text, which the content scan already catches. Some set only q.
//
// Deliberately not falling back to e tags. On a reply the e tag is the parent
// being replied to, not the note being pointed at, so promoting it would charge
// somebody for the wrong note. The q tag means "quoted" and nothing else.
func quotedEventID(event *nostr.Event) string {
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == "q" && len(tag[1]) == 64 {
			return tag[1]
		}
	}
	return ""
}
