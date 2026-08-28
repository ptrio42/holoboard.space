package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

// LNbitsBackend implements LightningBackend using LNbits API
type LNbitsBackend struct {
	apiKey     string // Invoice/Write key
	readKey    string // Read key for checking invoices
	httpClient *http.Client
	baseURL    string
}

// NewLNbitsBackend creates a new LNbits Lightning backend
func NewLNbitsBackend(apiKey, readKey, baseURL string) *LNbitsBackend {
	if baseURL == "" {
		baseURL = "https://legend.lnbits.com" // Default to legend.lnbits.com
	}
	return &LNbitsBackend{
		apiKey:  apiKey,
		readKey: readKey,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		baseURL: baseURL,
	}
}

// LNbits API Types

type lnbitsCreateInvoiceRequest struct {
	Out         bool   `json:"out"`         // false for incoming payment
	Amount      int64  `json:"amount"`      // Amount in satoshis
	Memo        string `json:"memo"`        // Invoice description
	Webhook     string `json:"webhook,omitempty"` // Optional webhook URL
	InternalID  string `json:"internal,omitempty"` // Optional internal ID
}

type lnbitsCreateInvoiceResponse struct {
	PaymentHash    string `json:"payment_hash"`
	PaymentRequest string `json:"payment_request"` // BOLT11 invoice
}

type lnbitsCheckInvoiceResponse struct {
	Paid   bool   `json:"paid"`
	Amount int64  `json:"amount"` // millisatoshis
}

// GenerateInvoice creates a new Lightning invoice via LNbits
func (l *LNbitsBackend) GenerateInvoice(ctx context.Context, amountSats int64, memo string) (*Invoice, error) {
	reqBody := lnbitsCreateInvoiceRequest{
		Out:    false, // Incoming payment
		Amount: amountSats,
		Memo:   memo,
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", l.baseURL+"/api/v1/payments", bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", l.apiKey)

	resp, err := l.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("lnbits API error (status %d): %s", resp.StatusCode, string(body))
	}

	var lnbitsResp lnbitsCreateInvoiceResponse
	if err := json.Unmarshal(body, &lnbitsResp); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %w", err)
	}

	invoice := &Invoice{
		PaymentRequest: lnbitsResp.PaymentRequest,
		PaymentHash:    lnbitsResp.PaymentHash,
		AmountSats:     amountSats,
		ExpiresAt:      time.Now().Add(1 * time.Hour), // LNbits default is 1 hour
	}

	log.Printf("Generated LNbits invoice: %d sats, payment hash: %s", amountSats, lnbitsResp.PaymentHash)

	return invoice, nil
}

// CheckInvoice checks if a specific invoice has been paid
func (l *LNbitsBackend) CheckInvoice(ctx context.Context, paymentHash string) (bool, int64, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", l.baseURL+"/api/v1/payments/"+paymentHash, nil)
	if err != nil {
		return false, 0, fmt.Errorf("failed to create request: %w", err)
	}

	// Use read key for checking invoice status
	req.Header.Set("X-Api-Key", l.readKey)

	resp, err := l.httpClient.Do(req)
	if err != nil {
		return false, 0, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, 0, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode == http.StatusNotFound {
		return false, 0, fmt.Errorf("invoice not found")
	}

	if resp.StatusCode != http.StatusOK {
		return false, 0, fmt.Errorf("lnbits API error (status %d): %s", resp.StatusCode, string(body))
	}

	var lnbitsResp lnbitsCheckInvoiceResponse
	if err := json.Unmarshal(body, &lnbitsResp); err != nil {
		return false, 0, fmt.Errorf("failed to unmarshal response: %w", err)
	}

	// Convert millisats to sats
	amountSats := lnbitsResp.Amount / 1000

	return lnbitsResp.Paid, amountSats, nil
}

// WatchInvoices monitors for paid invoices using polling
// Note: LNbits supports webhooks which would be more efficient
func (l *LNbitsBackend) WatchInvoices(ctx context.Context) (<-chan PaidInvoice, error) {
	ch := make(chan PaidInvoice)

	go func() {
		defer close(ch)

		// This is a simple polling implementation
		// In production, you should use LNbits webhooks instead
		// The webhook approach is more efficient

		for {
			select {
			case <-ctx.Done():
				return
			}
		}
	}()

	log.Printf("LNbits payment watcher started (no-op polling mode)")
	log.Printf("IMPORTANT: Use webhooks for production - see lnbits_webhook.go")

	return ch, nil
}

// LNbitsWebhookPayload represents the webhook payload from LNbits
// LNbits sends this to your webhook URL when an invoice is paid
type LNbitsWebhookPayload struct {
	PaymentHash string `json:"payment_hash"`
	Amount      int64  `json:"amount"` // millisatoshis
	Pending     bool   `json:"pending"`
}

// HandleWebhook processes LNbits webhook callbacks
// This should be called from an HTTP handler
func (l *LNbitsBackend) HandleWebhook(ctx context.Context, payload []byte) (*PaidInvoice, error) {
	var webhook LNbitsWebhookPayload
	if err := json.Unmarshal(payload, &webhook); err != nil {
		return nil, fmt.Errorf("failed to unmarshal webhook: %w", err)
	}

	// Only process completed payments
	if webhook.Pending {
		return nil, nil // Not completed yet
	}

	// Convert millisats to sats
	amountSats := webhook.Amount / 1000

	return &PaidInvoice{
		PaymentHash: webhook.PaymentHash,
		AmountSats:  amountSats,
		PaidAt:      time.Now(),
	}, nil
}

// SetupLNbitsWebhook is a helper to document webhook setup
func SetupLNbitsWebhook(baseURL, callbackURL string) {
	log.Printf("To use LNbits webhooks:")
	log.Printf("1. Set up an HTTP endpoint at: %s", callbackURL)
	log.Printf("2. When creating invoices, add the webhook parameter:")
	log.Printf("   {\"webhook\": \"%s\"}", callbackURL)
	log.Printf("3. Handle POST requests with HandleWebhook()")
	log.Printf("4. LNbits will send payment notifications to your webhook URL")
}
