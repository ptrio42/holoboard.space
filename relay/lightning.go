package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"time"
)

// LightningBackend interface for invoice generation and payment monitoring
type LightningBackend interface {
	// GenerateInvoice creates a new Lightning invoice
	GenerateInvoice(ctx context.Context, amountSats int64, memo string) (*Invoice, error)

	// WatchInvoices monitors for paid invoices
	WatchInvoices(ctx context.Context) (<-chan PaidInvoice, error)

	// CheckInvoice checks if a specific invoice has been paid.
	//
	// The returned amount is advisory. Wallets are inconsistent about it and
	// some omit it entirely for a pending invoice, so callers must credit the
	// amount recorded in storage instead of this one.
	CheckInvoice(ctx context.Context, paymentHash string) (bool, int64, error)
}

// Invoice represents a Lightning invoice
type Invoice struct {
	PaymentRequest string
	PaymentHash    string
	AmountSats     int64
	ExpiresAt      time.Time
}

// PaidInvoice represents a paid invoice notification
type PaidInvoice struct {
	PaymentHash string
	AmountSats  int64
	PaidAt      time.Time
}

// MockLightningBackend is a mock implementation for testing
type MockLightningBackend struct {
	invoices map[string]*Invoice
}

// NewMockLightningBackend creates a new mock backend
func NewMockLightningBackend() *MockLightningBackend {
	return &MockLightningBackend{
		invoices: make(map[string]*Invoice),
	}
}

// GenerateInvoice creates a mock invoice
func (m *MockLightningBackend) GenerateInvoice(ctx context.Context, amountSats int64, memo string) (*Invoice, error) {
	// Generate a random payment hash
	hashBytes := make([]byte, 32)
	if _, err := rand.Read(hashBytes); err != nil {
		return nil, fmt.Errorf("failed to generate payment hash: %w", err)
	}
	paymentHash := hex.EncodeToString(hashBytes)

	invoice := &Invoice{
		PaymentRequest: fmt.Sprintf("lnbc%d...mock_invoice", amountSats),
		PaymentHash:    paymentHash,
		AmountSats:     amountSats,
		ExpiresAt:      time.Now().Add(1 * time.Hour),
	}

	m.invoices[paymentHash] = invoice
	log.Printf("Generated mock invoice: %d sats, hash: %s", amountSats, paymentHash)

	return invoice, nil
}

// WatchInvoices returns a channel for paid invoice notifications
func (m *MockLightningBackend) WatchInvoices(ctx context.Context) (<-chan PaidInvoice, error) {
	ch := make(chan PaidInvoice)

	// In a real implementation, this would connect to LND/CLN and stream updates
	// For the mock, we just return an empty channel
	go func() {
		<-ctx.Done()
		close(ch)
	}()

	return ch, nil
}

// CheckInvoice checks if an invoice has been paid
func (m *MockLightningBackend) CheckInvoice(ctx context.Context, paymentHash string) (bool, int64, error) {
	invoice, exists := m.invoices[paymentHash]
	if !exists {
		return false, 0, fmt.Errorf("invoice not found")
	}

	// In the mock, invoices are never automatically paid
	// You'd manually trigger payment in tests
	return false, invoice.AmountSats, nil
}

// InvoiceManager handles invoice generation and payment tracking
type InvoiceManager struct {
	backend           LightningBackend
	storage           *Storage
	paymentMonitor    *PaymentMonitor
	defaultAmountSats int64
}

// NewInvoiceManager creates a new invoice manager
func NewInvoiceManager(backend LightningBackend, storage *Storage, monitor *PaymentMonitor, defaultAmount int64) *InvoiceManager {
	return &InvoiceManager{
		backend:           backend,
		storage:           storage,
		paymentMonitor:    monitor,
		defaultAmountSats: defaultAmount,
	}
}

// GeneratePromotionInvoice generates an invoice for promoting a post
// If amountSats is 0, uses the default amount
func (im *InvoiceManager) GeneratePromotionInvoice(ctx context.Context, postID string, amountSats int64) (*Invoice, error) {
	// Use default amount if not specified
	if amountSats == 0 {
		amountSats = im.defaultAmountSats
	}

	memo := fmt.Sprintf("Promote Nostr post: %s", postID)

	invoice, err := im.backend.GenerateInvoice(ctx, amountSats, memo)
	if err != nil {
		return nil, fmt.Errorf("failed to generate invoice: %w", err)
	}

	// Store the pending invoice
	pendingInvoice := &PendingInvoice{
		PostID:      postID,
		Invoice:     invoice.PaymentRequest,
		PaymentHash: invoice.PaymentHash,
		AmountSats:  invoice.AmountSats,
		CreatedAt:   time.Now(),
		ExpiresAt:   invoice.ExpiresAt, // Set expiry from backend
	}

	if err := im.storage.AddPendingInvoice(pendingInvoice); err != nil {
		return nil, fmt.Errorf("failed to store pending invoice: %w", err)
	}

	log.Printf("Generated invoice for post %s: %s (%d sats)", postID, invoice.PaymentHash, amountSats)
	return invoice, nil
}

// StartPaymentWatcher monitors for paid invoices
func (im *InvoiceManager) StartPaymentWatcher(ctx context.Context) error {
	paidCh, err := im.backend.WatchInvoices(ctx)
	if err != nil {
		return fmt.Errorf("failed to start watching invoices: %w", err)
	}

	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case paid := <-paidCh:
				if err := im.paymentMonitor.ProcessInvoicePayment(paid.PaymentHash, paid.AmountSats); err != nil {
					log.Printf("Failed to process invoice payment: %v", err)
				}
			}
		}
	}()

	log.Printf("Payment watcher started")
	return nil
}

// StartInvoiceReconciler asks the wallet about invoices we are still waiting on.
//
// It does two jobs. On boot it settles anything that was paid while the relay
// was down, which is the restart case DESIGN.md sketched out and nobody ever
// implemented. After that it keeps running on a ticker as a backstop for
// wallets that publish no payment notifications, so the payment loop closes
// even when WatchInvoices never emits anything.
//
// Without this, a backend whose WatchInvoices stays quiet leaves every invoice
// pending forever, which is exactly how the LNbits and Zebedee backends behaved.
func (im *InvoiceManager) StartInvoiceReconciler(ctx context.Context, interval time.Duration) {
	go func() {
		im.reconcilePendingInvoices(ctx)

		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				im.reconcilePendingInvoices(ctx)
			}
		}
	}()

	log.Printf("Invoice reconciler started (checks pending invoices every %s)", interval)
}

// reconcilePendingInvoices walks the pending invoices once and books the paid ones.
func (im *InvoiceManager) reconcilePendingInvoices(ctx context.Context) {
	pending := im.storage.ListPendingInvoices()
	if len(pending) == 0 {
		return
	}

	settled := 0
	for _, invoice := range pending {
		if ctx.Err() != nil {
			return
		}

		paid, _, err := im.backend.CheckInvoice(ctx, invoice.PaymentHash)
		if err != nil {
			log.Printf("Failed to check invoice %s: %v", short(invoice.PaymentHash, 12), err)
			continue
		}
		if !paid {
			continue
		}

		// Book the amount we asked for rather than one read back off the wire.
		// A fixed-amount invoice cannot settle for more than it was issued for,
		// so the stored figure is the safer of the two and keeps the ranking
		// independent of whatever a reply happens to claim.
		if err := im.paymentMonitor.ProcessInvoicePayment(invoice.PaymentHash, invoice.AmountSats); err != nil {
			log.Printf("Failed to book settled invoice %s: %v", short(invoice.PaymentHash, 12), err)
			continue
		}
		settled++
	}

	if settled > 0 {
		log.Printf("Reconciled %d of %d pending invoices", settled, len(pending))
	}
}
