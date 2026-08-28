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

	// CheckInvoice checks if a specific invoice has been paid
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

// SimulatePayment simulates a payment (for testing)
func (m *MockLightningBackend) SimulatePayment(paymentHash string) (*PaidInvoice, error) {
	invoice, exists := m.invoices[paymentHash]
	if !exists {
		return nil, fmt.Errorf("invoice not found")
	}

	return &PaidInvoice{
		PaymentHash: paymentHash,
		AmountSats:  invoice.AmountSats,
		PaidAt:      time.Now(),
	}, nil
}

// InvoiceManager handles invoice generation and payment tracking
type InvoiceManager struct {
	backend         LightningBackend
	storage         *Storage
	paymentMonitor  *PaymentMonitor
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

// LND Integration Example (commented out - requires actual LND connection)
/*
import (
	"github.com/lightningnetwork/lnd/lnrpc"
	"google.golang.org/grpc"
)

type LNDBackend struct {
	client lnrpc.LightningClient
}

func NewLNDBackend(address string, tlsCertPath string, macaroonPath string) (*LNDBackend, error) {
	// Load TLS credentials
	creds, err := credentials.NewClientTLSFromFile(tlsCertPath, "")
	if err != nil {
		return nil, err
	}

	// Load macaroon
	macaroonBytes, err := ioutil.ReadFile(macaroonPath)
	if err != nil {
		return nil, err
	}

	macaroon := &macaroonCredential{hex.EncodeToString(macaroonBytes)}

	// Connect to LND
	conn, err := grpc.Dial(address, grpc.WithTransportCredentials(creds), grpc.WithPerRPCCredentials(macaroon))
	if err != nil {
		return nil, err
	}

	client := lnrpc.NewLightningClient(conn)

	return &LNDBackend{client: client}, nil
}

func (l *LNDBackend) GenerateInvoice(ctx context.Context, amountSats int64, memo string) (*Invoice, error) {
	req := &lnrpc.Invoice{
		Value: amountSats,
		Memo:  memo,
	}

	resp, err := l.client.AddInvoice(ctx, req)
	if err != nil {
		return nil, err
	}

	return &Invoice{
		PaymentRequest: resp.PaymentRequest,
		PaymentHash:    hex.EncodeToString(resp.RHash),
		AmountSats:     amountSats,
		ExpiresAt:      time.Now().Add(1 * time.Hour),
	}, nil
}

func (l *LNDBackend) WatchInvoices(ctx context.Context) (<-chan PaidInvoice, error) {
	stream, err := l.client.SubscribeInvoices(ctx, &lnrpc.InvoiceSubscription{})
	if err != nil {
		return nil, err
	}

	ch := make(chan PaidInvoice)

	go func() {
		defer close(ch)
		for {
			invoice, err := stream.Recv()
			if err != nil {
				log.Printf("Invoice stream error: %v", err)
				return
			}

			if invoice.State == lnrpc.Invoice_SETTLED {
				ch <- PaidInvoice{
					PaymentHash: hex.EncodeToString(invoice.RHash),
					AmountSats:  invoice.Value,
					PaidAt:      time.Unix(invoice.SettleDate, 0),
				}
			}
		}
	}()

	return ch, nil
}
*/
