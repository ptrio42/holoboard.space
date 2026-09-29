package main

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"sync"
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
	publisher   *AccountPublisher
	runner      sync.WaitGroup
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

func (mm *MentionMonitor) SetAccountPublisher(publisher *AccountPublisher) {
	mm.publisher = publisher
}

// Start begins monitoring for mentions
func (mm *MentionMonitor) Start(ctx context.Context, relays []string) {
	log.Printf("Starting mention monitor for pubkey %s", mm.relayPubkey)

	// Keep relay subscriptions independent. In go-nostr's SubMany, a CLOSED
	// response from one relay cancels every subscription, leaving this monitor
	// silent until the process restarts.
	events := make(chan *nostr.Event)
	var watchers sync.WaitGroup
	for _, url := range relays {
		watchers.Add(1)
		go func(url string) {
			defer watchers.Done()
			mm.followRelay(ctx, url, events)
		}(url)
	}
	go func() {
		watchers.Wait()
		close(events)
	}()

	mm.runner.Add(1)
	go func() {
		defer mm.runner.Done()
		for event := range events {
			// Process mention
			if err := mm.ProcessMention(ctx, event); err != nil {
				log.Printf("Failed to process mention from %s: %v", event.PubKey, err)
			}
			// Keep the newest event time for diagnostics. Reconnects use the
			// bounded lookback instead of this watermark to catch late events.
			if err := mm.storage.AdvanceMentionWatermark(int64(event.CreatedAt)); err != nil {
				log.Printf("Failed to advance mention watermark: %v", err)
			}
		}
		log.Printf("Mention monitor stopped")
	}()

	log.Printf("Mention monitor started, watching %d relays", len(relays))
}

func (mm *MentionMonitor) Wait() {
	mm.runner.Wait()
}

// followRelay retries one relay without disrupting the others. Repeated quick
// refusals back off, while a connection that lasted a minute starts over at
// the shortest delay.
func (mm *MentionMonitor) followRelay(ctx context.Context, url string, out chan<- *nostr.Event) {
	const (
		minBackoff = 3 * time.Second
		maxBackoff = 2 * time.Minute
	)
	backoff := minBackoff

	for ctx.Err() == nil {
		started := time.Now()
		mm.followOnce(ctx, url, out)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) >= time.Minute {
			backoff = minBackoff
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < maxBackoff {
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
		}
	}
}

func (mm *MentionMonitor) followOnce(ctx context.Context, url string, out chan<- *nostr.Event) {
	relay, err := nostr.RelayConnect(ctx, url)
	if err != nil {
		log.Printf("Mention monitor could not connect to %s: %v", url, err)
		return
	}
	// Re-read a bounded window on every connection. A stored high watermark
	// can otherwise hide an older mention delivered late by a different relay.
	// ProcessMention ignores events already recorded in processed_mentions.
	since := nostr.Timestamp(time.Now().Add(-maxMentionBacklog).Unix())
	filter := nostr.Filter{
		Kinds: []int{1},
		Tags:  nostr.TagMap{"p": []string{mm.relayPubkey}},
		Since: &since,
	}
	sub, err := relay.Subscribe(ctx, []nostr.Filter{filter})
	if err != nil {
		log.Printf("Mention monitor could not subscribe on %s: %v", url, err)
		relay.Close()
		return
	}
	defer func() {
		// go-nostr also calls Unsub from a goroutine when a context ends.
		// Wait for that goroutine to finish before closing the connection,
		// so its final CLOSE write cannot race with Relay.Close.
		sub.Unsub()
		for range sub.Events {
		}
		relay.Close()
	}()
	log.Printf("Mention monitor watching %s since %s", url, time.Unix(int64(since), 0).Format(time.RFC3339))

	for {
		select {
		case <-ctx.Done():
			return
		case reason := <-sub.ClosedReason:
			log.Printf("Mention monitor subscription closed by %s: %s", url, reason)
			return
		case event, more := <-sub.Events:
			if !more {
				log.Printf("Mention monitor connection closed by %s", url)
				return
			}
			if event == nil {
				continue
			}
			select {
			case out <- event:
			case <-ctx.Done():
				return
			}
		}
	}
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
	noteToPromote, relayHint, err := mm.fetcher.FetchPostFromWithRelay(ctx, noteID, hints, author)
	if err != nil {
		log.Printf("Failed to fetch note %s: %v", noteID, err)
		return mm.SendErrorReply(ctx, mentionEvent, fmt.Sprintf("Could not find note %s. Please check the note ID.", short(noteID, 16)))
	}

	// Verify it's a kind:1 event
	if !isPromotable(noteToPromote.Kind) {
		return mm.SendErrorReply(ctx, mentionEvent, "Only text notes (kind:1) can be promoted.")
	}

	// Create promotional reply
	if err := mm.CreatePromotionalReply(ctx, mentionEvent, noteToPromote, relayHint); err != nil {
		return fmt.Errorf("failed to create promotional reply: %w", err)
	}
	if mm.publisher != nil {
		return nil // The reply and processed mention were committed together.
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
func (mm *MentionMonitor) buildPromotionalReply(mentionEvent *nostr.Event, noteToPromote *nostr.Event, relayHint string) (nostr.Event, error) {
	var relays []string
	if relayHint != "" {
		relays = []string{relayHint}
	}
	reference, err := nip19.EncodeEvent(noteToPromote.ID, relays, noteToPromote.PubKey)
	if err != nil {
		return nostr.Event{}, fmt.Errorf("encode promoted note reference: %w", err)
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
func (mm *MentionMonitor) CreatePromotionalReply(ctx context.Context, mentionEvent *nostr.Event, noteToPromote *nostr.Event, relayHint string) error {
	replyEvent, err := mm.buildPromotionalReply(mentionEvent, noteToPromote, relayHint)
	if err != nil {
		return err
	}

	// Sign the event
	if err := replyEvent.Sign(mm.relaySeckey); err != nil {
		return fmt.Errorf("failed to sign reply: %w", err)
	}
	if mm.publisher != nil {
		if err := mm.storage.QueuePromotionalReply(mentionEvent.ID, noteToPromote.ID, mentionEvent.PubKey, &replyEvent, mm.publisher.Targets()); err != nil {
			return err
		}
		mm.publisher.Wake()
		log.Printf("Queued promotional reply %s for note %s", short(replyEvent.ID, 8), short(noteToPromote.ID, 8))
		return nil
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
	if err := mm.storage.AddPromotionalReplyWithRequester(replyEvent.ID, noteToPromote.ID, mentionEvent.PubKey); err != nil {
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

// maxMentionBacklog caps how far back each connection looks for missed mentions.
const maxMentionBacklog = 24 * time.Hour

// resumePoint keeps DM subscriptions near their stored watermark without
// replaying messages from before the bounded backlog.
func resumePoint(watermark int64, now time.Time, maxBacklog time.Duration) int64 {
	floor := now.Add(-maxBacklog).Unix()
	if watermark <= 0 || watermark < floor {
		return floor
	}
	return watermark
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
