package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"sync"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// PromotedPost represents a paid post stored in the relay
type PromotedPost struct {
	PostID               string       `json:"post_id"`
	Event                *nostr.Event `json:"event"`
	TotalSatsPaid        int64        `json:"total_sats_paid"`
	LastPaymentTimestamp time.Time    `json:"last_payment_timestamp"`
}

// PendingInvoice tracks invoices generated for PROMOTE requests
type PendingInvoice struct {
	PostID      string    `json:"post_id"`
	Invoice     string    `json:"invoice"`
	PaymentHash string    `json:"payment_hash"`
	AmountSats  int64     `json:"amount_sats"`
	CreatedAt   time.Time `json:"created_at"`
	ExpiresAt   time.Time `json:"expires_at"`
}

// Storage manages promoted posts and pending invoices
type Storage struct {
	mu                 sync.RWMutex
	posts              map[string]*PromotedPost   // post_id -> PromotedPost
	pendingInvoices    map[string]*PendingInvoice // payment_hash -> PendingInvoice
	processedZaps      map[string]bool            // zap_event_id -> processed (for deduplication)
	processedDMs       map[string]bool            // dm_event_id -> processed (to prevent duplicate invoice sends)
	promotionalReplies map[string]string          // promotional_reply_id -> note_to_promote_id
	processedMentions  map[string]bool            // mention_event_id -> processed (to reply only once)
	dataFile           string
}

// NewStorage creates a new storage instance
func NewStorage(dataFile string) (*Storage, error) {
	s := &Storage{
		posts:              make(map[string]*PromotedPost),
		pendingInvoices:    make(map[string]*PendingInvoice),
		processedZaps:      make(map[string]bool),
		processedDMs:       make(map[string]bool),
		promotionalReplies: make(map[string]string),
		processedMentions:  make(map[string]bool),
		dataFile:           dataFile,
	}

	// Load existing data
	if err := s.load(); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("failed to load storage: %w", err)
	}

	return s, nil
}

// AddPayment adds or updates a post with a new payment
func (s *Storage) AddPayment(postID string, amountSats int64, event *nostr.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if amountSats <= 0 {
		return fmt.Errorf("invalid payment amount: %d", amountSats)
	}

	post, exists := s.posts[postID]
	if exists {
		// Update existing post
		post.TotalSatsPaid += amountSats
		post.LastPaymentTimestamp = time.Now()
		fmt.Printf("📈 Updated post %s: +%d sats (total: %d sats)\n",
			postID[:8], amountSats, post.TotalSatsPaid)
	} else {
		// Create new post entry
		if event == nil {
			return fmt.Errorf("cannot create new post without event")
		}
		post = &PromotedPost{
			PostID:               postID,
			Event:                event,
			TotalSatsPaid:        amountSats,
			LastPaymentTimestamp: time.Now(),
		}
		s.posts[postID] = post
		fmt.Printf("🆕 New post promoted: %s with %d sats\n", postID[:8], amountSats)
	}

	if err := s.save(); err != nil {
		return fmt.Errorf("failed to save after adding payment: %w", err)
	}
	return nil
}

// GetPost retrieves a promoted post by ID
func (s *Storage) GetPost(postID string) (*PromotedPost, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	post, exists := s.posts[postID]
	return post, exists
}

// HasPost checks if a post is already promoted
func (s *Storage) HasPost(postID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, exists := s.posts[postID]
	return exists
}

// QueryPosts returns posts matching the filter, sorted by payment ranking
func (s *Storage) QueryPosts(ctx context.Context, filter nostr.Filter) []*nostr.Event {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// Collect all promoted posts
	var posts []*PromotedPost
	for _, post := range s.posts {
		posts = append(posts, post)
	}

	// Sort by: total_sats DESC, last_payment_timestamp DESC, created_at DESC
	sort.Slice(posts, func(i, j int) bool {
		if posts[i].TotalSatsPaid != posts[j].TotalSatsPaid {
			return posts[i].TotalSatsPaid > posts[j].TotalSatsPaid
		}
		if !posts[i].LastPaymentTimestamp.Equal(posts[j].LastPaymentTimestamp) {
			return posts[i].LastPaymentTimestamp.After(posts[j].LastPaymentTimestamp)
		}
		return posts[i].Event.CreatedAt > posts[j].Event.CreatedAt
	})

	// Apply filter and collect matching events
	var results []*nostr.Event
	for _, post := range posts {
		if filter.Matches(post.Event) {
			results = append(results, post.Event)
		}
	}

	// Apply limit if specified
	if filter.Limit > 0 && len(results) > filter.Limit {
		results = results[:filter.Limit]
	}

	return results
}

// AddPendingInvoice stores a pending invoice
func (s *Storage) AddPendingInvoice(invoice *PendingInvoice) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.pendingInvoices[invoice.PaymentHash] = invoice
	return s.save()
}

// GetPendingInvoice retrieves a pending invoice by payment hash
func (s *Storage) GetPendingInvoice(paymentHash string) (*PendingInvoice, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	invoice, exists := s.pendingInvoices[paymentHash]
	return invoice, exists
}

// GetPendingInvoiceByBolt11 retrieves a pending invoice by bolt11 string
func (s *Storage) GetPendingInvoiceByBolt11(bolt11 string) (*PendingInvoice, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// Search through all pending invoices
	for _, invoice := range s.pendingInvoices {
		if invoice.Invoice == bolt11 {
			return invoice, true
		}
	}
	return nil, false
}

// RemovePendingInvoice removes a pending invoice after payment
func (s *Storage) RemovePendingInvoice(paymentHash string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	delete(s.pendingInvoices, paymentHash)
	return s.save()
}

// save persists the storage to disk
func (s *Storage) save() error {
	data := struct {
		Posts              map[string]*PromotedPost   `json:"posts"`
		PendingInvoices    map[string]*PendingInvoice `json:"pending_invoices"`
		ProcessedZaps      map[string]bool            `json:"processed_zaps"`
		ProcessedDMs       map[string]bool            `json:"processed_dms"`
		PromotionalReplies map[string]string          `json:"promotional_replies"`
		ProcessedMentions  map[string]bool            `json:"processed_mentions"`
	}{
		Posts:              s.posts,
		PendingInvoices:    s.pendingInvoices,
		ProcessedZaps:      s.processedZaps,
		ProcessedDMs:       s.processedDMs,
		PromotionalReplies: s.promotionalReplies,
		ProcessedMentions:  s.processedMentions,
	}

	bytes, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal data: %w", err)
	}

	if err := os.WriteFile(s.dataFile, bytes, 0644); err != nil {
		return fmt.Errorf("failed to write data file %s: %w", s.dataFile, err)
	}

	fmt.Printf("✅ Saved data to %s (%d posts, %d pending invoices)\n",
		s.dataFile, len(s.posts), len(s.pendingInvoices))
	return nil
}

// load reads the storage from disk
func (s *Storage) load() error {
	bytes, err := os.ReadFile(s.dataFile)
	if err != nil {
		return err
	}

	var data struct {
		Posts              map[string]*PromotedPost   `json:"posts"`
		PendingInvoices    map[string]*PendingInvoice `json:"pending_invoices"`
		ProcessedZaps      map[string]bool            `json:"processed_zaps"`
		ProcessedDMs       map[string]bool            `json:"processed_dms"`
		PromotionalReplies map[string]string          `json:"promotional_replies"`
		ProcessedMentions  map[string]bool            `json:"processed_mentions"`
	}

	if err := json.Unmarshal(bytes, &data); err != nil {
		return fmt.Errorf("failed to unmarshal data: %w", err)
	}

	s.posts = data.Posts
	if s.posts == nil {
		s.posts = make(map[string]*PromotedPost)
	}

	s.pendingInvoices = data.PendingInvoices
	if s.pendingInvoices == nil {
		s.pendingInvoices = make(map[string]*PendingInvoice)
	}

	s.processedZaps = data.ProcessedZaps
	if s.processedZaps == nil {
		s.processedZaps = make(map[string]bool)
	}

	s.processedDMs = data.ProcessedDMs
	if s.processedDMs == nil {
		s.processedDMs = make(map[string]bool)
	}

	s.promotionalReplies = data.PromotionalReplies
	if s.promotionalReplies == nil {
		s.promotionalReplies = make(map[string]string)
	}

	s.processedMentions = data.ProcessedMentions
	if s.processedMentions == nil {
		s.processedMentions = make(map[string]bool)
	}

	return nil
}

// AddPromotionalReply stores a mapping from promotional reply ID to the note it promotes
func (s *Storage) AddPromotionalReply(replyID, noteToPromoteID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.promotionalReplies[replyID] = noteToPromoteID
	return s.save()
}

// GetPromotedNoteID gets the note ID that a promotional reply promotes
func (s *Storage) GetPromotedNoteID(replyID string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	noteID, exists := s.promotionalReplies[replyID]
	return noteID, exists
}

// MarkMentionProcessed marks a mention as processed
func (s *Storage) MarkMentionProcessed(mentionEventID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.processedMentions[mentionEventID] = true
	return s.save()
}

// IsMentionProcessed checks if a mention has been processed
func (s *Storage) IsMentionProcessed(mentionEventID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return s.processedMentions[mentionEventID]
}

// CountPosts returns the total number of promoted posts
func (s *Storage) CountPosts() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.posts)
}

// HasProcessedZap checks if a zap has already been processed
func (s *Storage) HasProcessedZap(zapEventID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.processedZaps[zapEventID]
}

// MarkZapProcessed marks a zap as processed to prevent duplicate processing
func (s *Storage) MarkZapProcessed(zapEventID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.processedZaps[zapEventID] = true
	return s.save()
}

// IsDMProcessed checks if a DM has already been processed
func (s *Storage) IsDMProcessed(dmEventID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.processedDMs[dmEventID]
}

// MarkDMProcessed marks a DM as processed to prevent duplicate invoice sends
func (s *Storage) MarkDMProcessed(dmEventID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.processedDMs[dmEventID] = true
	return s.save()
}

// CleanupExpiredInvoices removes invoices that have expired
func (s *Storage) CleanupExpiredInvoices() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	removed := 0

	for hash, invoice := range s.pendingInvoices {
		if now.After(invoice.ExpiresAt) {
			delete(s.pendingInvoices, hash)
			removed++
		}
	}

	if removed > 0 {
		fmt.Printf("🧹 Cleaned up %d expired invoices\n", removed)
		return s.save()
	}

	return nil
}

// CheckAndMarkZapProcessed atomically checks if a zap has been processed
// and marks it as processed if not. Returns true if this is the first time
// processing this zap, false if it was already processed.
func (s *Storage) CheckAndMarkZapProcessed(zapEventID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Check if already processed
	if s.processedZaps[zapEventID] {
		return false, nil // Already processed
	}

	// Mark as processed
	s.processedZaps[zapEventID] = true

	// Save to disk
	if err := s.save(); err != nil {
		// Rollback if save fails
		delete(s.processedZaps, zapEventID)
		return false, err
	}

	return true, nil // First time processing
}
