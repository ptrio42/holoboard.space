package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"

	"github.com/btcsuite/btcd/chaincfg"
	"github.com/lightningnetwork/lnd/zpay32"
	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip19"
)

// PaymentMonitor handles zap events and payment verification
type PaymentMonitor struct {
	storage      *Storage
	relayPubkey  string
	fetcher      *PostFetcher
}

// NewPaymentMonitor creates a new payment monitor
func NewPaymentMonitor(storage *Storage, relayPubkey string, fetcher *PostFetcher) *PaymentMonitor {
	return &PaymentMonitor{
		storage:     storage,
		relayPubkey: relayPubkey,
		fetcher:     fetcher,
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

	// Verify this zap is directed to our relay
	zapRecipient := ""
	for _, tag := range zapEvent.Tags {
		if len(tag) >= 2 && tag[0] == "p" {
			zapRecipient = tag[1]
			break
		}
	}

	if zapRecipient != pm.relayPubkey {
		return fmt.Errorf("zap not directed to relay pubkey")
	}

	// Extract the zap request from the description tag
	var description string
	for _, tag := range zapEvent.Tags {
		if len(tag) >= 2 && tag[0] == "description" {
			description = tag[1]
			break
		}
	}

	if description == "" {
		return fmt.Errorf("zap missing description tag")
	}

	// Parse the zap request (kind 9734 event embedded in description)
	var zapRequest nostr.Event
	if err := json.Unmarshal([]byte(description), &zapRequest); err != nil {
		return fmt.Errorf("failed to parse zap request: %w", err)
	}

	// Extract the amount from the bolt11 tag
	var bolt11 string
	for _, tag := range zapEvent.Tags {
		if len(tag) >= 2 && tag[0] == "bolt11" {
			bolt11 = tag[1]
			break
		}
	}

	if bolt11 == "" {
		return fmt.Errorf("zap missing bolt11 tag")
	}

	amountMsat := extractAmountFromBolt11(bolt11)
	amountSats := amountMsat / 1000

	log.Printf("Extracted amount from bolt11: %d millisats = %d sats (bolt11: %s...)", amountMsat, amountSats, bolt11[:min(20, len(bolt11))])

	if amountSats <= 0 {
		log.Printf("Ignoring zap with zero amount (< 1 sat)")
		return nil
	}

	// Extract the post ID from multiple possible sources, with priority order:
	// 1. HIGHEST PRIORITY: Check if zapped event is a promotional reply (from mention flow)
	//    - If so, get the promoted note ID from the promotional reply mapping
	//    - Ignore any note ID in zap content/description for this flow
	// 2. Check if this bolt11 matches a pending invoice from PROMOTE command (DM flow)
	// 3. Extract from the zap comment (zapRequest.Content)
	// 4. Extract from the bolt11 invoice description field (wallet label/description)

	var postID string

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
		promotedNoteID, err := pm.getPromotedNoteFromChain(zappedEventID)
		if err == nil && promotedNoteID != "" {
			postID = promotedNoteID
			log.Printf("Zap to promotional reply %s -> promoting note %s (via chain)", zappedEventID[:8], postID[:8])
		} else if err != nil {
			log.Printf("Chain-chasing failed for %s: %v, trying storage fallback", zappedEventID[:8], err)
		}

		// Fallback to storage mapping (for older promotional replies)
		if postID == "" {
			promotedNoteIDFromStorage, isPromotionalReply := pm.storage.GetPromotedNoteID(zappedEventID)
			if isPromotionalReply {
				postID = promotedNoteIDFromStorage
				log.Printf("Zap to promotional reply %s -> promoting note %s (via storage)", zappedEventID[:8], postID[:8])
			}
		}
	}

	// PRIORITY 2: Check if this bolt11 was sent via DM (PROMOTE command flow)
	if postID == "" && bolt11 != "" {
		pendingInvoice, exists := pm.storage.GetPendingInvoiceByBolt11(bolt11)
		if exists {
			postID = pendingInvoice.PostID
			log.Printf("Matched bolt11 to DM invoice for post %s", postID[:8])
		}
	}

	// PRIORITY 3: Try extracting from zap comment
	if postID == "" && zapRequest.Content != "" {
		postID = extractEventIDFromText(zapRequest.Content)
		if postID != "" {
			log.Printf("Extracted post ID from zap comment: %s", postID[:8])
		}
	}

	// PRIORITY 4: Try the bolt11 description field (wallet label/description)
	if postID == "" && bolt11 != "" {
		bolt11Description := extractDescriptionFromBolt11(bolt11)
		if bolt11Description != "" {
			log.Printf("Checking bolt11 description for post ID: %s", bolt11Description)
			postID = extractEventIDFromText(bolt11Description)
			if postID != "" {
				log.Printf("Extracted post ID from bolt11 description: %s", postID[:8])
			}
		}
	}

	if postID == "" {
		return fmt.Errorf("zap request missing post ID (checked: promotional replies, DM invoices, zap content, bolt11 description)")
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
		fetchedEvent, err := pm.fetcher.FetchPost(ctx, postID)
		if err != nil {
			log.Printf("Failed to fetch post %s: %v", postID, err)
			return fmt.Errorf("failed to fetch post: %w", err)
		}

		// Verify it's a kind:1 event
		if fetchedEvent.Kind != 1 {
			return fmt.Errorf("event %s is not kind:1 (got kind:%d)", postID, fetchedEvent.Kind)
		}

		// Store with payment
		if err := pm.storage.AddPayment(postID, amountSats, fetchedEvent); err != nil {
			return fmt.Errorf("failed to store post: %w", err)
		}

		log.Printf("Fetched and stored post %s with %d sats", postID, amountSats)
	} else {
		// Update existing post
		if err := pm.storage.AddPayment(postID, amountSats, post.Event); err != nil {
			return fmt.Errorf("failed to update post payment: %w", err)
		}

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
		fetchedEvent, err := pm.fetcher.FetchPost(ctx, invoice.PostID)
		if err != nil {
			return fmt.Errorf("failed to fetch post: %w", err)
		}

		if fetchedEvent.Kind != 1 {
			return fmt.Errorf("event is not kind:1")
		}

		// Store with payment
		if err := pm.storage.AddPayment(invoice.PostID, amountSats, fetchedEvent); err != nil {
			return fmt.Errorf("failed to store post: %w", err)
		}
	} else {
		// Update existing post
		if err := pm.storage.AddPayment(invoice.PostID, amountSats, post.Event); err != nil {
			return fmt.Errorf("failed to update post: %w", err)
		}
	}

	// Remove the pending invoice
	if err := pm.storage.RemovePendingInvoice(paymentHash); err != nil {
		log.Printf("Failed to remove pending invoice: %v", err)
	}

	return nil
}

// getPromotedNoteFromChain reconstructs the promotion chain from events
// Chain: Zap -> Promotional Reply -> Original Mention -> Extract Note ID
func (pm *PaymentMonitor) getPromotedNoteFromChain(promotionalReplyID string) (string, error) {
	ctx := context.Background()

	// Step 1: Fetch the promotional reply
	promotionalReply, err := pm.fetchEvent(ctx, promotionalReplyID, []int{1}) // kind:1 notes
	if err != nil {
		return "", fmt.Errorf("failed to fetch promotional reply: %w", err)
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
		return "", fmt.Errorf("promotional reply has no 'e' tag (no parent mention)")
	}

	log.Printf("Found mention ID %s from promotional reply %s", mentionID[:8], promotionalReplyID[:8])

	// Step 3: Fetch the original mention
	mention, err := pm.fetchEvent(ctx, mentionID, []int{1}) // kind:1 notes
	if err != nil {
		return "", fmt.Errorf("failed to fetch mention: %w", err)
	}

	// Step 4: Extract note ID from mention content
	noteID := extractEventIDFromText(mention.Content)
	if noteID == "" {
		return "", fmt.Errorf("no note ID found in mention content")
	}

	log.Printf("Extracted note ID %s from mention content", noteID[:8])
	return noteID, nil
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
				log.Printf("Fetched event %s from %s", eventID[:8], relayURL)
				return event, nil
			}
		case <-sub.EndOfStoredEvents:
			log.Printf("Event %s not found on %s", eventID[:8], relayURL)
		}
	}

	return nil, fmt.Errorf("event %s not found on any relay", eventID[:8])
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

// FetchPost fetches a post by ID from configured relays
func (pf *PostFetcher) FetchPost(ctx context.Context, postID string) (*nostr.Event, error) {
	if len(pf.relays) == 0 {
		return nil, fmt.Errorf("no relays configured for fetching")
	}

	// Create a filter for this specific event
	filters := []nostr.Filter{
		{
			IDs:   []string{postID},
			Kinds: []int{1},
			Limit: 1,
		},
	}

	// Try to fetch from each relay
	for _, relayURL := range pf.relays {
		relay, err := nostr.RelayConnect(ctx, relayURL)
		if err != nil {
			log.Printf("Failed to connect to relay %s: %v", relayURL, err)
			continue
		}

		events, err := relay.QuerySync(ctx, filters[0])
		relay.Close()

		if err != nil {
			log.Printf("Failed to query relay %s: %v", relayURL, err)
			continue
		}

		if len(events) > 0 {
			log.Printf("Found post %s on relay %s", postID, relayURL)
			return events[0], nil
		}
	}

	return nil, fmt.Errorf("post %s not found on any relay", postID)
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

// extractAmountFromBolt11 extracts the amount in millisats from a bolt11 invoice
// This is a simplified parser that looks for the amount in the bolt11 string
func extractAmountFromBolt11(bolt11 string) int64 {
	if len(bolt11) < 10 {
		return 0
	}

	// BOLT11 format: ln{prefix}{amount}{suffix}
	// Amount can be: empty (any amount), or number followed by multiplier (m=milli, u=micro, n=nano, p=pico)
	// Multipliers are in units of Bitcoin:
	//   m = milli-bitcoin = 0.001 BTC = 100,000 sats = 100,000,000 millisats
	//   u = micro-bitcoin = 0.000001 BTC = 100 sats = 100,000 millisats
	//   n = nano-bitcoin = 0.000000001 BTC = 0.1 sats = 100 millisats
	//   p = pico-bitcoin = 0.000000000001 BTC = 0.0001 sats = 0.1 millisats
	// Example: lnbc10n = 10 nano-bitcoin = 10 * 100 millisats = 1000 millisats = 1 sat

	// Remove the 'ln' prefix and get the network+amount part
	if !strings.HasPrefix(bolt11, "ln") {
		return 0
	}

	// Extract just the amount portion (after 'lnbc'/'lnbt'/etc)
	var amountStr string
	re := regexp.MustCompile(`^ln[a-z0-9]+?(\d+[munp]?)`)
	matches := re.FindStringSubmatch(bolt11)

	if len(matches) < 2 {
		return 0
	}

	amountStr = matches[1]
	if amountStr == "" {
		return 0
	}

	// Parse the multiplier (in millisats per unit)
	multiplier := int64(100_000_000_000) // Default: 1 bitcoin = 100,000,000,000 millisats
	lastChar := amountStr[len(amountStr)-1]

	var numStr string
	switch lastChar {
	case 'm': // milli-bitcoin = 100,000,000 millisats
		multiplier = 100_000_000
		numStr = amountStr[:len(amountStr)-1]
	case 'u': // micro-bitcoin = 100,000 millisats
		multiplier = 100_000
		numStr = amountStr[:len(amountStr)-1]
	case 'n': // nano-bitcoin = 100 millisats
		multiplier = 100
		numStr = amountStr[:len(amountStr)-1]
	case 'p': // pico-bitcoin = 0.1 millisats (round down to 0)
		multiplier = 0
		numStr = amountStr[:len(amountStr)-1]
	default:
		// No multiplier = bitcoin
		numStr = amountStr
	}

	num, err := strconv.ParseInt(numStr, 10, 64)
	if err != nil {
		return 0
	}

	return num * multiplier
}

// ExtractAmountFromInvoice extracts the amount in sats from a bolt11 invoice
func ExtractAmountFromInvoice(bolt11 string) int64 {
	amountMsat := extractAmountFromBolt11(bolt11)
	return amountMsat / 1000
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

// ValidateZapEvent performs additional validation on a zap event
func ValidateZapEvent(zapEvent *nostr.Event) error {
	if zapEvent.Kind != 9735 {
		return fmt.Errorf("event is not a zap (kind 9735)")
	}

	// Check for required tags
	hasP := false
	hasBolt11 := false
	hasDescription := false

	for _, tag := range zapEvent.Tags {
		if len(tag) >= 1 {
			switch tag[0] {
			case "p":
				hasP = true
			case "bolt11":
				hasBolt11 = true
			case "description":
				hasDescription = true
			}
		}
	}

	if !hasP {
		return fmt.Errorf("missing 'p' tag")
	}
	if !hasBolt11 {
		return fmt.Errorf("missing 'bolt11' tag")
	}
	if !hasDescription {
		return fmt.Errorf("missing 'description' tag")
	}

	return nil
}
