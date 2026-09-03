package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// Payment is one sum paid for one note, at one moment.
//
// Kept individually because ranking decays each payment from its own date. A
// single figure with a last-paid date cannot express that, and using one would
// hand anybody a way to refresh a large old total by paying a single sat.
type Payment struct {
	Sats int64     `json:"sats"`
	At   time.Time `json:"at"`
}

// PromotedPost represents a paid post stored in the relay
type PromotedPost struct {
	PostID               string       `json:"post_id"`
	Event                *nostr.Event `json:"event"`
	TotalSatsPaid        int64        `json:"total_sats_paid"`
	LastPaymentTimestamp time.Time    `json:"last_payment_timestamp"`
	// Payments is the history TotalSatsPaid is the sum of. Posts stored before
	// this existed have none, and are treated as a single payment on their last
	// payment date.
	Payments []Payment `json:"payments,omitempty"`
}

// rankHalfLife is how long it takes a payment to count for half of what it did.
//
// The board is a place people pay to be seen, and without this the only way to
// move is to out-pay everything ever paid before you, so the top silts up with
// whoever got there first and nobody after them can afford the climb. Sats do
// not stop having been paid; they stop being recent.
var rankHalfLife = 30 * 24 * time.Hour

// score is what the board actually orders by: every payment, each faded by its
// own age. The number of sats paid is reported unchanged, because that is a
// fact and this is an opinion about it.
func (p *PromotedPost) score(now time.Time) float64 {
	history := p.Payments
	if len(history) == 0 {
		// Everything paid before the history existed, dated as one payment.
		history = []Payment{{Sats: p.TotalSatsPaid, At: p.LastPaymentTimestamp}}
	}

	var total float64
	for _, payment := range history {
		age := now.Sub(payment.At)
		if age < 0 {
			age = 0
		}
		total += float64(payment.Sats) * math.Pow(0.5, age.Seconds()/rankHalfLife.Seconds())
	}
	return total
}

// PendingInvoice tracks invoices generated for PROMOTE requests
type PendingInvoice struct {
	PostID      string    `json:"post_id"`
	Invoice     string    `json:"invoice"`
	PaymentHash string    `json:"payment_hash"`
	AmountSats  int64     `json:"amount_sats"`
	CreatedAt   time.Time `json:"created_at"`
	ExpiresAt   time.Time `json:"expires_at"`
	// Where the note was said to live, and who wrote it. Kept because the note
	// is fetched again when the invoice settles, and by then the reference the
	// person pasted is long gone; without these, a note findable before payment
	// can be unfindable after it.
	RelayHints []string `json:"relay_hints,omitempty"`
	Author     string   `json:"author,omitempty"`
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
	removed            map[string]bool            // post_id -> taken off the board by the operator, and kept off
	mentionWatermark   int64                      // newest mention seen, so a restart does not skip the gap
	dmWatermark        int64                      // same, for DMs
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
		removed:            make(map[string]bool),
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

	// A removal that a payment can undo is not a removal. Whoever had the note
	// taken down would otherwise put it back for a single sat.
	if s.removed[postID] {
		return fmt.Errorf("post %s was removed by the operator", short(postID, 8))
	}

	post, exists := s.posts[postID]
	if exists {
		// Update existing post
		post.TotalSatsPaid += amountSats
		post.LastPaymentTimestamp = time.Now()
		post.Payments = append(post.Payments, Payment{Sats: amountSats, At: post.LastPaymentTimestamp})
		fmt.Printf("📈 Updated post %s: +%d sats (total: %d sats)\n",
			short(postID, 8), amountSats, post.TotalSatsPaid)
	} else {
		// Create new post entry
		if event == nil {
			return fmt.Errorf("cannot create new post without event")
		}
		now := time.Now()
		post = &PromotedPost{
			PostID:               postID,
			Event:                event,
			TotalSatsPaid:        amountSats,
			LastPaymentTimestamp: now,
			Payments:             []Payment{{Sats: amountSats, At: now}},
		}
		s.posts[postID] = post
		fmt.Printf("🆕 New post promoted: %s with %d sats\n", short(postID, 8), amountSats)
	}

	if err := s.save(); err != nil {
		return fmt.Errorf("failed to save after adding payment: %w", err)
	}
	return nil
}

// RemovePost takes a note off the board and keeps it off.
//
// The relay is deliberately indifferent to what it ranks: pay and you are
// ranked. That works right up against content the operator cannot host, and
// until this existed the only way out was hand-editing the data file on the
// volume and restarting. Sats already paid are not refunded, and this does not
// pretend to be a moderation system; it is the ability to take one thing down.
//
// It returns what the note had collected, so the operator can see what was
// removed rather than being told "done".
func (s *Storage) RemovePost(postID string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var sats int64
	if post, exists := s.posts[postID]; exists {
		sats = post.TotalSatsPaid
		delete(s.posts, postID)
	}
	s.removed[postID] = true

	if err := s.save(); err != nil {
		return sats, fmt.Errorf("failed to save after removing post: %w", err)
	}
	fmt.Printf("🚫 Removed post %s from the board (%d sats, not refunded)\n", short(postID, 8), sats)
	return sats, nil
}

// RestorePost lifts a removal, so the note can be paid onto the board again.
// It does not put back what was there: the sats it had collected are gone with
// the entry, and the note has to earn its rank over.
func (s *Storage) RestorePost(postID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.removed[postID] {
		return fmt.Errorf("post %s is not removed", short(postID, 8))
	}
	delete(s.removed, postID)

	if err := s.save(); err != nil {
		return fmt.Errorf("failed to save after restoring post: %w", err)
	}
	fmt.Printf("↩️  Restored post %s; it can be promoted again\n", short(postID, 8))
	return nil
}

// IsRemoved reports whether the operator has taken this note off the board.
func (s *Storage) IsRemoved(postID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.removed[postID]
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

// rankLess is the board's running order: most sats first, then whoever paid
// most recently, then the older note. It lives in one place because the events
// served over the websocket and the ledger served over HTTP have to agree about
// who is first, and two copies of a three-level comparison would not stay in
// step.
func rankLess(a, b *PromotedPost) bool {
	return rankLessAt(a, b, time.Now())
}

func rankLessAt(a, b *PromotedPost, now time.Time) bool {
	scoreA, scoreB := a.score(now), b.score(now)
	if scoreA != scoreB {
		return scoreA > scoreB
	}
	if a.TotalSatsPaid != b.TotalSatsPaid {
		return a.TotalSatsPaid > b.TotalSatsPaid
	}
	if !a.LastPaymentTimestamp.Equal(b.LastPaymentTimestamp) {
		return a.LastPaymentTimestamp.After(b.LastPaymentTimestamp)
	}
	return a.Event.CreatedAt > b.Event.CreatedAt
}

// LedgerEntry is what one note has been paid, as served to clients.
type LedgerEntry struct {
	ID       string `json:"id"`
	SatsPaid int64  `json:"sats_paid"`
	// Weight is what those sats are worth today, which is what the order is
	// actually built from. Served because a list sorted by a number nobody can
	// see is a list nobody can check: without it a note with fewer sats sitting
	// higher reads as a bug rather than as an old note giving way to a new one.
	Weight     int64 `json:"weight"`
	LastPaidAt int64 `json:"last_paid_at"` // unix seconds, 0 if never
	Rank       int   `json:"rank"`         // 1-based, matching the served order
}

// Ledger returns every promoted note with what it has been paid, in board
// order. A nostr event is signed, so its tags cannot carry the sats total
// without invalidating the signature; this is how the figure reaches clients
// instead.
func (s *Storage) Ledger() []LedgerEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()

	posts := make([]*PromotedPost, 0, len(s.posts))
	for _, post := range s.posts {
		posts = append(posts, post)
	}
	// One clock for the whole listing, so the order and the weights beside it
	// describe the same moment.
	now := time.Now()
	sort.Slice(posts, func(i, j int) bool { return rankLessAt(posts[i], posts[j], now) })

	entries := make([]LedgerEntry, 0, len(posts))
	for i, post := range posts {
		var lastPaid int64
		if !post.LastPaymentTimestamp.IsZero() {
			lastPaid = post.LastPaymentTimestamp.Unix()
		}
		entries = append(entries, LedgerEntry{
			ID:         post.PostID,
			SatsPaid:   post.TotalSatsPaid,
			Weight:     int64(math.Round(post.score(now))),
			LastPaidAt: lastPaid,
			Rank:       i + 1,
		})
	}
	return entries
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

	sort.Slice(posts, func(i, j int) bool { return rankLess(posts[i], posts[j]) })

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

// ListPendingInvoices returns a snapshot of every pending invoice. Handing back
// a copy lets callers take their time hitting the network per invoice without
// holding the storage lock while they do it.
func (s *Storage) ListPendingInvoices() []*PendingInvoice {
	s.mu.RLock()
	defer s.mu.RUnlock()

	invoices := make([]*PendingInvoice, 0, len(s.pendingInvoices))
	for _, invoice := range s.pendingInvoices {
		invoices = append(invoices, invoice)
	}
	return invoices
}

// RemovePendingInvoice removes a pending invoice after payment
func (s *Storage) RemovePendingInvoice(paymentHash string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	delete(s.pendingInvoices, paymentHash)
	return s.save()
}

// writeFileAtomic writes to a sibling file, flushes it, and renames it over the
// target, so a reader only ever sees a whole file.
//
// Writing straight onto the live ledger meant a process that died mid-write
// left truncated JSON behind, and load() has no fallback for that: NewStorage
// returns an error and main.go turns it into log.Fatalf. The relay would refuse
// to boot with its entire payment history gone. This is not a remote
// possibility either, since save() runs on every single payment and fly deploy
// shuts the old machine down with SIGTERM.
func writeFileAtomic(path string, data []byte) error {
	tmp := path + ".tmp"

	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return fmt.Errorf("failed to create temp file %s: %w", tmp, err)
	}

	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return fmt.Errorf("failed to write temp file %s: %w", tmp, err)
	}
	// Rename is atomic, but only for content the kernel has actually taken.
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return fmt.Errorf("failed to flush temp file %s: %w", tmp, err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("failed to close temp file %s: %w", tmp, err)
	}

	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("failed to replace %s: %w", path, err)
	}

	// The rename itself needs flushing, or a power loss can leave the directory
	// entry pointing at neither file. Best effort: a filesystem that will not
	// open its own directory is not a reason to fail a save that succeeded.
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		dir.Sync()
		dir.Close()
	}

	return nil
}

// Quiesce blocks until any save in flight has finished. Shutdown waits on it so
// the process cannot exit in the gap between a payment being recorded in memory
// and it reaching disk.
func (s *Storage) Quiesce() {
	s.mu.Lock()
	defer s.mu.Unlock()
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
		Removed            map[string]bool            `json:"removed"`
		MentionWatermark   int64                      `json:"mention_watermark"`
		DMWatermark        int64                      `json:"dm_watermark"`
	}{
		Posts:              s.posts,
		PendingInvoices:    s.pendingInvoices,
		ProcessedZaps:      s.processedZaps,
		ProcessedDMs:       s.processedDMs,
		PromotionalReplies: s.promotionalReplies,
		ProcessedMentions:  s.processedMentions,
		Removed:            s.removed,
		MentionWatermark:   s.mentionWatermark,
		DMWatermark:        s.dmWatermark,
	}

	bytes, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal data: %w", err)
	}

	if err := writeFileAtomic(s.dataFile, bytes); err != nil {
		return err
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
		Removed            map[string]bool            `json:"removed"`
		MentionWatermark   int64                      `json:"mention_watermark"`
		DMWatermark        int64                      `json:"dm_watermark"`
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

	s.removed = data.Removed
	if s.removed == nil {
		s.removed = make(map[string]bool)
	}

	s.mentionWatermark = data.MentionWatermark
	s.dmWatermark = data.DMWatermark

	return nil
}

// MentionWatermark is the timestamp of the newest mention already seen.
//
// The mention monitor used to subscribe from time.Now(), which meant every
// mention sent while the relay was restarting or redeploying was never seen at
// all: no reply, no promotion, and no trace that anything was missed. Persisting
// where it got to lets it pick the thread back up.
func (s *Storage) MentionWatermark() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.mentionWatermark
}

// AdvanceMentionWatermark moves the watermark forward. It never moves back, so
// events arriving out of order cannot rewind it.
func (s *Storage) AdvanceMentionWatermark(createdAt int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if createdAt <= s.mentionWatermark {
		return nil
	}
	s.mentionWatermark = createdAt
	return s.save()
}

// DMWatermark is the timestamp of the newest DM already handled.
//
// The DM monitor subscribed with a Limit and no Since, so on a fresh volume it
// pulled the last hundred DMs ever sent to the relay and answered every one of
// them with a new Lightning invoice. That is not hypothetical: the first deploy
// re-invoiced months-old PROMOTE requests. processed_dms alone was never enough,
// because a new volume starts with it empty.
func (s *Storage) DMWatermark() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.dmWatermark
}

// AdvanceDMWatermark moves the DM watermark forward, never back.
func (s *Storage) AdvanceDMWatermark(createdAt int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if createdAt <= s.dmWatermark {
		return nil
	}
	s.dmWatermark = createdAt
	return s.save()
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

// kindComment is NIP-22, a threading note scoped to a root event.
const kindComment = 1111

// isPromotable reports whether the board will rank an event of this kind.
//
// Comments are in for the same reason plain notes are: NIP-22 gives them
// plaintext content and nothing else to render, and the board already carried
// replies written as kind:1, which are fragments of a conversation in exactly
// the same way. Excluding 1111 while accepting those drew the line at the kind
// number rather than at anything a reader would notice.
func isPromotable(kind int) bool {
	return kind == 1 || kind == kindComment
}
