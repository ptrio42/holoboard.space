package main

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// stubBackend answers CheckInvoice from a table, so a test can decide exactly
// which invoices the wallet considers paid.
type stubBackend struct {
	mu     sync.Mutex
	paid   map[string]int64
	checks map[string]int
	err    error
}

func newStubBackend() *stubBackend {
	return &stubBackend{paid: map[string]int64{}, checks: map[string]int{}}
}

func (s *stubBackend) GenerateInvoice(context.Context, int64, string) (*Invoice, error) {
	return nil, fmt.Errorf("not used in this test")
}

func (s *stubBackend) WatchInvoices(ctx context.Context) (<-chan PaidInvoice, error) {
	ch := make(chan PaidInvoice)
	go func() {
		<-ctx.Done()
		close(ch)
	}()
	return ch, nil
}

func (s *stubBackend) CheckInvoice(_ context.Context, paymentHash string) (bool, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.checks[paymentHash]++
	if s.err != nil {
		return false, 0, s.err
	}
	amount, paid := s.paid[paymentHash]
	return paid, amount, nil
}

func (s *stubBackend) checkCount(paymentHash string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.checks[paymentHash]
}

// seedPromotedPost puts a post in storage so ProcessInvoicePayment can credit it
// without reaching out to the network for the event.
func seedPromotedPost(t *testing.T, storage *Storage, seckey string) string {
	t.Helper()

	evt := &nostr.Event{
		CreatedAt: nostr.Now(),
		Kind:      1,
		Tags:      nostr.Tags{},
		Content:   "a note somebody wants promoted",
	}
	if err := evt.Sign(seckey); err != nil {
		t.Fatalf("failed to sign seed event: %v", err)
	}
	if err := storage.AddPayment(evt.ID, 1, evt); err != nil {
		t.Fatalf("failed to seed post: %v", err)
	}
	return evt.ID
}

func newTestStorage(t *testing.T) *Storage {
	t.Helper()

	storage, err := NewStorage(filepath.Join(t.TempDir(), "relay_data.json"))
	if err != nil {
		t.Fatalf("failed to create storage: %v", err)
	}
	return storage
}

// TestReconcilerBooksSettledInvoices is the test that matters for the payment
// loop: an invoice paid while nothing was watching must still end up credited
// to its post. This is the restart case DESIGN.md described and that the LNbits
// and Zebedee backends never implemented, which is why 36 invoices sat pending.
func TestReconcilerBooksSettledInvoices(t *testing.T) {
	storage := newTestStorage(t)
	seckey := nostr.GeneratePrivateKey()
	postID := seedPromotedPost(t, storage, seckey)

	settled := &PendingInvoice{
		PostID:      postID,
		Invoice:     "lnbc10u1settled",
		PaymentHash: "1111111111111111",
		AmountSats:  1000,
		CreatedAt:   time.Now(),
		ExpiresAt:   time.Now().Add(time.Hour),
	}
	unpaid := &PendingInvoice{
		PostID:      postID,
		Invoice:     "lnbc10u1unpaid",
		PaymentHash: "2222222222222222",
		AmountSats:  7000,
		CreatedAt:   time.Now(),
		ExpiresAt:   time.Now().Add(time.Hour),
	}
	for _, inv := range []*PendingInvoice{settled, unpaid} {
		if err := storage.AddPendingInvoice(inv); err != nil {
			t.Fatalf("failed to store pending invoice: %v", err)
		}
	}

	backend := newStubBackend()
	// The wallet reports a wildly different amount than the invoice was issued
	// for. The reconciler must ignore it and book what we actually asked for.
	backend.paid[settled.PaymentHash] = 999_999_999

	manager := NewInvoiceManager(backend, storage, NewPaymentMonitor(storage, "relay", NewPostFetcher(nil)), 1000)
	manager.reconcilePendingInvoices(context.Background())

	post, exists := storage.GetPost(postID)
	if !exists {
		t.Fatal("seeded post disappeared")
	}
	// 1 sat from seeding plus the 1000 the invoice was issued for.
	if post.TotalSatsPaid != 1001 {
		t.Errorf("post total = %d sats, want 1001 (the invoice amount, not the wallet's figure)",
			post.TotalSatsPaid)
	}

	if _, stillPending := storage.GetPendingInvoice(settled.PaymentHash); stillPending {
		t.Error("settled invoice should have been removed from pending")
	}
	if _, stillPending := storage.GetPendingInvoice(unpaid.PaymentHash); !stillPending {
		t.Error("unpaid invoice should still be pending")
	}
}

// TestReconcilerSkipsFailedChecks makes sure one unreachable wallet response
// does not drop an invoice or credit anything.
func TestReconcilerSkipsFailedChecks(t *testing.T) {
	storage := newTestStorage(t)
	seckey := nostr.GeneratePrivateKey()
	postID := seedPromotedPost(t, storage, seckey)

	invoice := &PendingInvoice{
		PostID:      postID,
		Invoice:     "lnbc10u1unknown",
		PaymentHash: "3333333333333333",
		AmountSats:  500,
		CreatedAt:   time.Now(),
		ExpiresAt:   time.Now().Add(time.Hour),
	}
	if err := storage.AddPendingInvoice(invoice); err != nil {
		t.Fatalf("failed to store pending invoice: %v", err)
	}

	backend := newStubBackend()
	backend.err = fmt.Errorf("wallet unreachable")

	manager := NewInvoiceManager(backend, storage, NewPaymentMonitor(storage, "relay", NewPostFetcher(nil)), 1000)
	manager.reconcilePendingInvoices(context.Background())

	if _, stillPending := storage.GetPendingInvoice(invoice.PaymentHash); !stillPending {
		t.Error("invoice should survive a failed check")
	}

	post, _ := storage.GetPost(postID)
	if post.TotalSatsPaid != 1 {
		t.Errorf("post total = %d sats, want the seeded 1", post.TotalSatsPaid)
	}
}

// TestReconcilerRunsOnStartAndOnTicker covers the scheduling: the first pass
// has to happen immediately rather than one interval later, otherwise invoices
// paid during downtime stay unbooked for as long as the interval.
func TestReconcilerRunsOnStartAndOnTicker(t *testing.T) {
	storage := newTestStorage(t)
	seckey := nostr.GeneratePrivateKey()
	postID := seedPromotedPost(t, storage, seckey)

	invoice := &PendingInvoice{
		PostID:      postID,
		Invoice:     "lnbc10u1pending",
		PaymentHash: "4444444444444444",
		AmountSats:  250,
		CreatedAt:   time.Now(),
		ExpiresAt:   time.Now().Add(time.Hour),
	}
	if err := storage.AddPendingInvoice(invoice); err != nil {
		t.Fatalf("failed to store pending invoice: %v", err)
	}

	backend := newStubBackend() // reports nothing as paid, so it keeps polling

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	manager := NewInvoiceManager(backend, storage, NewPaymentMonitor(storage, "relay", NewPostFetcher(nil)), 1000)
	manager.StartInvoiceReconciler(ctx, 50*time.Millisecond)

	deadline := time.Now().Add(5 * time.Second)
	for backend.checkCount(invoice.PaymentHash) < 3 {
		if time.Now().After(deadline) {
			t.Fatalf("reconciler only checked the invoice %d times, want at least 3",
				backend.checkCount(invoice.PaymentHash))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestReconcilerStopsWithContext makes sure the ticker goroutine goes away.
func TestReconcilerStopsWithContext(t *testing.T) {
	storage := newTestStorage(t)
	seckey := nostr.GeneratePrivateKey()
	postID := seedPromotedPost(t, storage, seckey)

	invoice := &PendingInvoice{
		PostID:      postID,
		PaymentHash: "5555555555555555",
		AmountSats:  100,
		CreatedAt:   time.Now(),
		ExpiresAt:   time.Now().Add(time.Hour),
	}
	if err := storage.AddPendingInvoice(invoice); err != nil {
		t.Fatalf("failed to store pending invoice: %v", err)
	}

	backend := newStubBackend()
	ctx, cancel := context.WithCancel(context.Background())

	manager := NewInvoiceManager(backend, storage, NewPaymentMonitor(storage, "relay", NewPostFetcher(nil)), 1000)
	manager.StartInvoiceReconciler(ctx, 20*time.Millisecond)

	time.Sleep(100 * time.Millisecond)
	cancel()
	time.Sleep(100 * time.Millisecond)

	before := backend.checkCount(invoice.PaymentHash)
	time.Sleep(200 * time.Millisecond)

	if after := backend.checkCount(invoice.PaymentHash); after != before {
		t.Errorf("reconciler kept polling after cancellation: %d checks became %d", before, after)
	}
}
