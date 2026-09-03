package main

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/btcsuite/btcd/chaincfg"
	"github.com/lightningnetwork/lnd/zpay32"
	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip19"
)

// PaymentMonitor handles zap events and payment verification
type PaymentMonitor struct {
	storage     *Storage
	relayPubkey string
	fetcher     *PostFetcher
	// zapValidator holds the nostr keys this relay's LNURL servers sign
	// receipts with. Without one, no zap can be believed.
	zapValidator *LNURLResolver

	// broadcast pushes a freshly promoted note to whoever is subscribed right
	// now. Without it a note only appears on a client's next REQ, which for the
	// board means the page has to be reloaded before you can see the promotion
	// you just paid for.
	broadcast func(*nostr.Event)
}

// SetBroadcaster wires the relay's own broadcast in. It is set after
// construction because the khatru relay does not exist yet when the payment
// monitor is built.
func (pm *PaymentMonitor) SetBroadcaster(broadcast func(*nostr.Event)) {
	pm.broadcast = broadcast
}

// announce pushes an event to live subscriptions, if anything is wired up.
func (pm *PaymentMonitor) announce(event *nostr.Event) {
	if pm.broadcast != nil && event != nil {
		pm.broadcast(event)
	}
}

// NewPaymentMonitor creates a new payment monitor
func NewPaymentMonitor(storage *Storage, relayPubkey string, fetcher *PostFetcher, zapValidator *LNURLResolver) *PaymentMonitor {
	return &PaymentMonitor{
		storage:      storage,
		relayPubkey:  relayPubkey,
		fetcher:      fetcher,
		zapValidator: zapValidator,
	}
}

// ProcessZap processes a zap event (kind 9735)
func (pm *PaymentMonitor) ProcessZap(ctx context.Context, zapEvent *nostr.Event) error {
	// Atomically check if we've already processed this zap and mark it as processed
	// This prevents race conditions where multiple monitors process the same zap
	isFirstTime, err := pm.storage.CheckAndMarkZapProcessed(zapEvent.ID)
	if err != nil {
		return fmt.Errorf("failed to check/mark zap: %w", err)
	}
	if !isFirstTime {
		log.Printf("Zap %s already processed, skipping", zapEvent.ID)
		return nil
	}

	// Everything that makes this receipt mean anything is checked here: that
	// this relay's own LNURL server signed it, that the bolt11 decodes as a
	// real mainnet invoice, and that the invoice's description hash ties it to
	// the zap request it carries. Before this, a stranger's keypair and an
	// invented string bought whatever rank they felt like.
	details, err := ValidateZapReceipt(zapEvent, pm.relayPubkey, pm.zapValidator)
	if err != nil {
		return fmt.Errorf("rejected zap %s: %w", short(zapEvent.ID, 8), err)
	}

	zapRequest := *details.Request
	amountSats := details.AmountSats
	bolt11 := firstTag(zapEvent, "bolt11")

	log.Printf("Zap %s verified: %d sats", short(zapEvent.ID, 8), amountSats)

	// Extract the post ID from multiple possible sources, with priority order:
	// 1. HIGHEST PRIORITY: Check if zapped event is a promotional reply (from mention flow)
	//    - If so, get the promoted note ID from the promotional reply mapping
	//    - Ignore any note ID in zap content/description for this flow
	// 2. Check if this bolt11 matches a pending invoice from PROMOTE command (DM flow)
	// 3. Extract from the zap comment (zapRequest.Content)
	//
	// There used to be a fourth, reading the bolt11's own description field. A
	// zap invoice carries a description hash instead of a description, and
	// zpay32 treats the two as mutually exclusive, so that branch could never
	// fire for a receipt that now passes validation.

	var postID string
	// Wherever the id came from, the same place said where the note lives.
	// Losing that between here and the fetch is how a perfectly good reference
	// ends up reported as a note that does not exist.
	var hints []string
	var author string

	// PRIORITY 1: Check if this is a zap to a promotional reply
	// Look for 'e' tag in zap request to identify the zapped event
	var zappedEventID string
	for _, tag := range zapRequest.Tags {
		if len(tag) >= 2 && tag[0] == "e" {
			zappedEventID = tag[1]
			break
		}
	}

	if zappedEventID != "" {
		// Try chain-chasing approach: fetch the zapped event and check if it's a promotional reply
		promotedNoteID, chainHints, chainAuthor, err := pm.getPromotedNoteFromChain(zappedEventID)
		if err == nil && promotedNoteID != "" {
			postID = promotedNoteID
			hints, author = chainHints, chainAuthor
			log.Printf("Zap to promotional reply %s -> promoting note %s (via chain)", short(zappedEventID, 8), short(postID, 8))
		} else if err != nil {
			log.Printf("Chain-chasing failed for %s: %v, trying storage fallback", short(zappedEventID, 8), err)
		}

		// Fallback to storage mapping (for older promotional replies)
		if postID == "" {
			promotedNoteIDFromStorage, isPromotionalReply := pm.storage.GetPromotedNoteID(zappedEventID)
			if isPromotionalReply {
				postID = normalizeEventID(promotedNoteIDFromStorage)
				log.Printf("Zap to promotional reply %s -> promoting note %s (via storage)", short(zappedEventID, 8), short(postID, 8))
			}
		}
	}

	// PRIORITY 2: Check if this bolt11 was sent via DM (PROMOTE command flow)
	if postID == "" && bolt11 != "" {
		pendingInvoice, exists := pm.storage.GetPendingInvoiceByBolt11(bolt11)
		if exists {
			postID = pendingInvoice.PostID
			hints, author = pendingInvoice.RelayHints, pendingInvoice.Author
			log.Printf("Matched bolt11 to DM invoice for post %s", short(postID, 8))
		}
	}

	// PRIORITY 3: Try extracting from zap comment
	if postID == "" && zapRequest.Content != "" {
		reference := extractEventIDFromText(zapRequest.Content)
		if reference != "" {
			postID = reference
			hints, author = noteHints(reference)
			log.Printf("Extracted post ID from zap comment: %s", short(postID, 8))
		}
	}

	if postID == "" {
		return fmt.Errorf("zap request missing post ID (checked: promotional replies, DM invoices, zap content)")
	}

	// Normalize the post ID (handle nevent/note formats)
	postID = normalizeEventID(postID)

	// Validate it's a proper hex ID
	if len(postID) != 64 {
		return fmt.Errorf("invalid post ID format: %s", postID)
	}

	log.Printf("Received zap %s for post %s: %d sats", zapEvent.ID, postID, amountSats)

	// Check if we already have this post
	post, exists := pm.storage.GetPost(postID)

	if !exists {
		// Fetch the post from other relays
		log.Printf("Post %s not found locally, fetching from network...", postID)
		fetchedEvent, err := pm.fetcher.FetchPostFrom(ctx, postID, hints, author)
		if err != nil {
			log.Printf("Failed to fetch post %s: %v", postID, err)
			return fmt.Errorf("failed to fetch post: %w", err)
		}

		// Verify it's a kind:1 event
		if !isPromotable(fetchedEvent.Kind) {
			return fmt.Errorf("event %s is kind:%d, which this board does not rank", postID, fetchedEvent.Kind)
		}

		// Store with payment
		if err := pm.storage.AddPayment(postID, amountSats, fetchedEvent); err != nil {
			return fmt.Errorf("failed to store post: %w", err)
		}

		pm.announce(fetchedEvent)
		log.Printf("Fetched and stored post %s with %d sats", postID, amountSats)
	} else {
		// Update existing post
		if err := pm.storage.AddPayment(postID, amountSats, post.Event); err != nil {
			return fmt.Errorf("failed to update post payment: %w", err)
		}

		pm.announce(post.Event)
		log.Printf("Updated post %s, total sats: %d", postID, post.TotalSatsPaid+amountSats)
	}

	return nil
}

// ProcessInvoicePayment handles payments for invoices generated via PROMOTE flow
func (pm *PaymentMonitor) ProcessInvoicePayment(paymentHash string, amountSats int64) error {
	invoice, exists := pm.storage.GetPendingInvoice(paymentHash)
	if !exists {
		return fmt.Errorf("no pending invoice found for payment hash: %s", paymentHash)
	}

	log.Printf("Invoice paid for post %s: %d sats", invoice.PostID, amountSats)

	// Fetch the post if we don't have it
	post, exists := pm.storage.GetPost(invoice.PostID)

	ctx := context.Background()
	if !exists {
		fetchedEvent, err := pm.fetcher.FetchPostFrom(ctx, invoice.PostID, invoice.RelayHints, invoice.Author)
		if err != nil {
			return fmt.Errorf("failed to fetch post: %w", err)
		}

		if !isPromotable(fetchedEvent.Kind) {
			return fmt.Errorf("event is kind:%d, which this board does not rank", fetchedEvent.Kind)
		}

		// Store with payment
		if err := pm.storage.AddPayment(invoice.PostID, amountSats, fetchedEvent); err != nil {
			return fmt.Errorf("failed to store post: %w", err)
		}
		pm.announce(fetchedEvent)
	} else {
		// Update existing post
		if err := pm.storage.AddPayment(invoice.PostID, amountSats, post.Event); err != nil {
			return fmt.Errorf("failed to update post: %w", err)
		}
		pm.announce(post.Event)
	}

	// Remove the pending invoice
	if err := pm.storage.RemovePendingInvoice(paymentHash); err != nil {
		log.Printf("Failed to remove pending invoice: %v", err)
	}

	return nil
}

// getPromotedNoteFromChain reconstructs the promotion chain from events
// Chain: Zap -> Promotional Reply -> Original Mention -> Extract Note ID
func (pm *PaymentMonitor) getPromotedNoteFromChain(promotionalReplyID string) (string, []string, string, error) {
	ctx := context.Background()

	// Step 1: Fetch the promotional reply
	promotionalReply, err := pm.fetchEvent(ctx, promotionalReplyID, []int{1}) // kind:1 notes
	if err != nil {
		return "", nil, "", fmt.Errorf("failed to fetch promotional reply: %w", err)
	}

	// Step 2: Extract the mention ID from promotional reply's 'e' tag
	var mentionID string
	for _, tag := range promotionalReply.Tags {
		if len(tag) >= 2 && tag[0] == "e" {
			mentionID = tag[1]
			break
		}
	}

	if mentionID == "" {
		return "", nil, "", fmt.Errorf("promotional reply has no 'e' tag (no parent mention)")
	}

	log.Printf("Found mention ID %s from promotional reply %s", short(mentionID, 8), short(promotionalReplyID, 8))

	// Step 3: Fetch the original mention
	mention, err := pm.fetchEvent(ctx, mentionID, []int{1}) // kind:1 notes
	if err != nil {
		return "", nil, "", fmt.Errorf("failed to fetch mention: %w", err)
	}

	// Step 4: Extract note ID from mention content
	reference := extractEventIDFromText(mention.Content)
	if reference == "" {
		return "", nil, "", fmt.Errorf("no note ID found in mention content")
	}
	// The mention is where the person said which note they meant, so it is also
	// where they said where it lives. Carrying that out of here is what lets a
	// note off this board's relays survive to settlement.
	hints, author := noteHints(reference)
	noteID := reference

	// Normalise before returning, so callers and their log lines see a hex id
	// rather than a bech32 prefix. Logs used to read "promoting note nevent1q",
	// which is the same eight useless characters for every note.
	noteID = normalizeEventID(noteID)
	log.Printf("Extracted note ID %s from mention content", short(noteID, 8))
	return noteID, hints, author, nil
}

// fetchEvent fetches a single event by ID from configured relays
func (pm *PaymentMonitor) fetchEvent(ctx context.Context, eventID string, kinds []int) (*nostr.Event, error) {
	if pm.fetcher == nil {
		return nil, fmt.Errorf("no fetcher configured")
	}

	relays := pm.fetcher.Relays()
	if len(relays) == 0 {
		return nil, fmt.Errorf("no relays configured for fetching")
	}

	// Create a filter for this specific event
	filters := []nostr.Filter{
		{
			IDs:   []string{eventID},
			Kinds: kinds,
			Limit: 1,
		},
	}

	// Try to fetch from each relay
	for _, relayURL := range relays {
		relay, err := nostr.RelayConnect(ctx, relayURL)
		if err != nil {
			log.Printf("Failed to connect to relay %s: %v", relayURL, err)
			continue
		}
		defer relay.Close()

		// Query for the event
		sub, err := relay.Subscribe(ctx, filters)
		if err != nil {
			log.Printf("Failed to subscribe to relay %s: %v", relayURL, err)
			continue
		}

		// Wait for the event (with timeout)
		select {
		case event := <-sub.Events:
			if event != nil {
				log.Printf("Fetched event %s from %s", short(eventID, 8), relayURL)
				return event, nil
			}
		case <-sub.EndOfStoredEvents:
			log.Printf("Event %s not found on %s", short(eventID, 8), relayURL)
		}
	}

	return nil, fmt.Errorf("event %s not found on any relay", short(eventID, 8))
}

// PostFetcher fetches posts from other Nostr relays
type PostFetcher struct {
	relays []string
}

// NewPostFetcher creates a new post fetcher
func NewPostFetcher(relays []string) *PostFetcher {
	return &PostFetcher{
		relays: relays,
	}
}

// Relays returns the list of relays this fetcher uses
func (pf *PostFetcher) Relays() []string {
	return pf.relays
}

// FetchPost fetches a post by ID from the configured relays.
func (pf *PostFetcher) FetchPost(ctx context.Context, postID string) (*nostr.Event, error) {
	return pf.FetchPostFrom(ctx, postID, nil, "")
}

// FetchPostFrom looks for a note on the relays it was pointed at as well as the
// configured ones, and asks them all at once.
//
// Both halves of that matter. An nevent carries relay hints and an author for
// exactly this reason, and throwing them away means refusing to look where the
// person who handed you the reference said to look; a note that lives nowhere
// near this board's five relays was simply declared not to exist. And querying
// in turn meant one slow relay could spend the whole budget before the others
// were tried, so a note that was findable still was not found.
//
// When the hints and the configured relays both come up empty and an author is
// known, their own write relays are the last place worth asking: that is where
// they publish, whatever anybody else happens to carry.
func (pf *PostFetcher) FetchPostFrom(ctx context.Context, postID string, hints []string, author string) (*nostr.Event, error) {
	candidates := dedupe(append(append([]string{}, hints...), pf.relays...))
	if len(candidates) == 0 && author == "" {
		return nil, fmt.Errorf("no relays configured for fetching")
	}

	if event := queryAll(ctx, candidates, postID); event != nil {
		return event, nil
	}

	if author != "" {
		if writeRelays := authorWriteRelays(ctx, author, candidates); len(writeRelays) > 0 {
			log.Printf("Looking for %s on %s's own relays", short(postID, 8), short(author, 8))
			if event := queryAll(ctx, writeRelays, postID); event != nil {
				return event, nil
			}
		}
	}

	return nil, fmt.Errorf("post %s not found on any relay", postID)
}

// queryAll asks every relay at once and takes the first answer.
func queryAll(ctx context.Context, relays []string, postID string) *nostr.Event {
	if len(relays) == 0 {
		return nil
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	// No kind filter. An id names exactly one event, so narrowing by kind buys
	// nothing and costs the difference between "we could not find it" and "we
	// found it and it is not the sort of thing this board takes". Callers check
	// the kind themselves and can say which it was.
	filter := nostr.Filter{IDs: []string{postID}, Limit: 1}
	found := make(chan *nostr.Event, len(relays))

	var wg sync.WaitGroup
	for _, url := range relays {
		wg.Add(1)
		go func(url string) {
			defer wg.Done()

			relay, err := nostr.RelayConnect(ctx, url)
			if err != nil {
				return
			}
			defer relay.Close()

			events, err := relay.QuerySync(ctx, filter)
			if err != nil || len(events) == 0 {
				return
			}
			log.Printf("Found post %s on relay %s", short(postID, 8), url)
			select {
			case found <- events[0]:
			default:
			}
		}(url)
	}

	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()

	select {
	case event := <-found:
		return event
	case <-done:
		select {
		case event := <-found:
			return event
		default:
			return nil
		}
	case <-ctx.Done():
		return nil
	}
}

// authorWriteRelays reads where somebody publishes, from their NIP-65 list.
func authorWriteRelays(ctx context.Context, author string, searchOn []string) []string {
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()

	sources := dedupe(append(append([]string{}, discoveryRelays...), searchOn...))

	var mu sync.Mutex
	var newest *nostr.Event

	var wg sync.WaitGroup
	for _, url := range sources {
		wg.Add(1)
		go func(url string) {
			defer wg.Done()

			relay, err := nostr.RelayConnect(ctx, url)
			if err != nil {
				return
			}
			defer relay.Close()

			found, err := relay.QuerySync(ctx, nostr.Filter{
				Kinds: []int{kindRelayList}, Authors: []string{author}, Limit: 1,
			})
			if err != nil || len(found) == 0 {
				return
			}

			mu.Lock()
			defer mu.Unlock()
			if newest == nil || found[0].CreatedAt > newest.CreatedAt {
				newest = found[0]
			}
		}(url)
	}
	wg.Wait()

	if newest == nil {
		return nil
	}

	var writes []string
	for _, tag := range newest.Tags {
		// NIP-65: an r tag with no marker is both read and write.
		if len(tag) >= 2 && tag[0] == "r" && (len(tag) < 3 || tag[2] == "write") {
			writes = append(writes, tag[1])
		}
	}
	return writes
}

// extractEventIDFromText extracts event IDs from text content
// Looks for: nostr:nevent1..., nostr:note1..., nevent1..., note1..., or hex IDs
func extractEventIDFromText(text string) string {
	// Try to find bech32 encoded IDs (note1, nevent1) with or without nostr: prefix
	bech32Pattern := regexp.MustCompile(`(?:nostr:)?((?:note1|nevent1)[a-z0-9]+)`)
	if matches := bech32Pattern.FindStringSubmatch(text); len(matches) >= 2 {
		return matches[1]
	}

	// Try to find 64-character hex IDs
	hexPattern := regexp.MustCompile(`\b([0-9a-fA-F]{64})\b`)
	if matches := hexPattern.FindStringSubmatch(text); len(matches) >= 2 {
		return matches[1]
	}

	return ""
}

// normalizeEventID converts various event ID formats to hex
// Supports: hex, note1..., nevent1..., nostr:note1..., nostr:nevent1...
func normalizeEventID(identifier string) string {
	// Remove nostr: prefix if present
	identifier = strings.TrimPrefix(identifier, "nostr:")

	// If it's already 64 char hex, return as-is (lowercased)
	if len(identifier) == 64 {
		// Check if it's valid hex
		isHex := true
		for _, c := range identifier {
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
				isHex = false
				break
			}
		}
		if isHex {
			return strings.ToLower(identifier)
		}
	}

	// Try to decode as bech32 (note1... or nevent1...)
	if strings.HasPrefix(identifier, "note1") || strings.HasPrefix(identifier, "nevent1") {
		prefix, value, err := nip19.Decode(identifier)
		if err != nil {
			// If decode fails, return original (will fail validation later)
			return identifier
		}

		switch prefix {
		case "note":
			// note is a direct hex event ID
			return strings.ToLower(value.(string))
		case "nevent":
			// nevent contains event pointer with additional data
			if ep, ok := value.(nostr.EventPointer); ok {
				return strings.ToLower(ep.ID)
			}
		}
	}

	// Return original if we can't parse it
	return identifier
}

// ParsePromoteCommand parses a PROMOTE command from a DM
// Expected formats:
// - "PROMOTE <hex_id>" (64 char hex, uses default amount)
// - "PROMOTE <amount_sats> <hex_id>" (custom amount)
// - "PROMOTE note1..." (bech32 note format, uses default amount)
// - "PROMOTE <amount_sats> note1..." (custom amount with bech32)
// - "PROMOTE nevent1..." (bech32 nevent format, uses default amount)
// - "PROMOTE <amount_sats> nevent1..." (custom amount with bech32)
// - "PROMOTE nostr:note1..." (with nostr: prefix, uses default amount)
// - "PROMOTE <amount_sats> nostr:nevent1..." (custom amount with nostr: prefix)
// Returns: postID (hex), amountSats (0 if not specified), ok
func ParsePromoteCommand(content string) (postID string, amountSats int64, ok bool) {
	content = strings.TrimSpace(content)
	parts := strings.Fields(content)

	if len(parts) < 2 || len(parts) > 3 {
		return "", 0, false
	}

	if strings.ToUpper(parts[0]) != "PROMOTE" {
		return "", 0, false
	}

	// Check if we have 2 or 3 parts
	if len(parts) == 2 {
		// Format: PROMOTE <post_id>
		postID = normalizeEventID(parts[1])
		amountSats = 0 // Use default
	} else {
		// Format: PROMOTE <amount> <post_id>
		// Try to parse the amount
		amount, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || amount <= 0 {
			return "", 0, false
		}
		amountSats = amount
		postID = normalizeEventID(parts[2])
	}

	// Validate final postID is 64 hex characters
	if len(postID) != 64 {
		return "", 0, false
	}

	// Basic hex validation
	for _, c := range postID {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return "", 0, false
		}
	}

	return postID, amountSats, true
}

// extractDescriptionFromBolt11 extracts the description field from a bolt11 invoice
func extractDescriptionFromBolt11(bolt11 string) string {
	// Decode the invoice using zpay32
	invoice, err := zpay32.Decode(bolt11, &chaincfg.MainNetParams)
	if err != nil {
		// Try testnet
		invoice, err = zpay32.Decode(bolt11, &chaincfg.TestNet3Params)
		if err != nil {
			log.Printf("Failed to decode bolt11 invoice: %v", err)
			return ""
		}
	}

	// Return the description if present
	if invoice.Description != nil && *invoice.Description != "" {
		return *invoice.Description
	}

	return ""
}

// noteHints pulls the relay hints and author out of an nevent, which is what
// they are there for. A note1 or a bare hex id carries neither.
func noteHints(reference string) (relays []string, author string) {
	trimmed := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(reference), "nostr:"))
	if !strings.HasPrefix(trimmed, "nevent1") {
		return nil, ""
	}

	prefix, value, err := nip19.Decode(trimmed)
	if err != nil || prefix != "nevent" {
		return nil, ""
	}

	pointer, ok := value.(nostr.EventPointer)
	if !ok {
		return nil, ""
	}
	return pointer.Relays, pointer.Author
}
