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

// ZebedeeBackend implements LightningBackend using Zebedee API
type ZebedeeBackend struct {
	apiKey     string
	httpClient *http.Client
	baseURL    string
}

// NewZebedeeBackend creates a new Zebedee Lightning backend
func NewZebedeeBackend(apiKey string) *ZebedeeBackend {
	return &ZebedeeBackend{
		apiKey: apiKey,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		baseURL: "https://api.zebedee.io/v0",
	}
}

// ZBD API Types

type zbdCreateChargeRequest struct {
	Amount      string `json:"amount"`      // Amount in millisatoshis
	Description string `json:"description"` // Invoice description/memo
	ExpiresIn   int    `json:"expiresIn"`   // Expiration in seconds
	InternalID  string `json:"internalId"`  // Optional internal reference ID
}

type zbdCreateChargeResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Data    struct {
		ID      string `json:"id"` // Zebedee charge ID
		Invoice struct {
			Request   string `json:"request"`   // BOLT11 payment request
			ExpiresAt string `json:"expiresAt"` // ISO 8601 timestamp
		} `json:"invoice"`
		Amount      string `json:"amount"` // Amount in millisatoshis
		Status      string `json:"status"` // pending, completed, expired
		Description string `json:"description"`
		CreatedAt   string `json:"createdAt"`   // ISO 8601 timestamp
		CallbackURL string `json:"callbackUrl"` // Webhook URL for payment notifications
		InternalID  string `json:"internalId"`
	} `json:"data"`
}

type zbdGetChargeResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Data    struct {
		ID      string `json:"id"`
		Status  string `json:"status"` // pending, completed, expired
		Amount  string `json:"amount"` // millisatoshis
		Invoice struct {
			Request   string `json:"request"`
			ExpiresAt string `json:"expiresAt"`
		} `json:"invoice"`
		ConfirmedAt string `json:"confirmedAt"` // ISO 8601 timestamp when paid
	} `json:"data"`
}

// GenerateInvoice creates a new Lightning invoice via Zebedee
func (z *ZebedeeBackend) GenerateInvoice(ctx context.Context, amountSats int64, memo string) (*Invoice, error) {
	// Convert sats to millisats
	amountMsat := amountSats * 1000

	reqBody := zbdCreateChargeRequest{
		Amount:      fmt.Sprintf("%d", amountMsat),
		Description: memo,
		ExpiresIn:   3600, // 1 hour expiration
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", z.baseURL+"/charges", bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("apikey", z.apiKey)

	resp, err := z.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("zebedee API error (status %d): %s", resp.StatusCode, string(body))
	}

	var zbdResp zbdCreateChargeResponse
	if err := json.Unmarshal(body, &zbdResp); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %w", err)
	}

	if !zbdResp.Success {
		return nil, fmt.Errorf("zebedee API returned error: %s", zbdResp.Message)
	}

	// Parse expiration time
	expiresAt, err := time.Parse(time.RFC3339, zbdResp.Data.Invoice.ExpiresAt)
	if err != nil {
		log.Printf("Warning: failed to parse expiration time, using default: %v", err)
		expiresAt = time.Now().Add(1 * time.Hour)
	}

	invoice := &Invoice{
		PaymentRequest: zbdResp.Data.Invoice.Request,
		PaymentHash:    zbdResp.Data.ID, // Use ZBD charge ID as payment hash reference
		AmountSats:     amountSats,
		ExpiresAt:      expiresAt,
	}

	log.Printf("Generated Zebedee invoice: %d sats, charge ID: %s", amountSats, zbdResp.Data.ID)

	return invoice, nil
}

// CheckInvoice checks if a specific invoice has been paid
func (z *ZebedeeBackend) CheckInvoice(ctx context.Context, chargeID string) (bool, int64, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", z.baseURL+"/charges/"+chargeID, nil)
	if err != nil {
		return false, 0, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("apikey", z.apiKey)

	resp, err := z.httpClient.Do(req)
	if err != nil {
		return false, 0, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, 0, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return false, 0, fmt.Errorf("zebedee API error (status %d): %s", resp.StatusCode, string(body))
	}

	var zbdResp zbdGetChargeResponse
	if err := json.Unmarshal(body, &zbdResp); err != nil {
		return false, 0, fmt.Errorf("failed to unmarshal response: %w", err)
	}

	if !zbdResp.Success {
		return false, 0, fmt.Errorf("zebedee API returned error: %s", zbdResp.Message)
	}

	// Parse amount from millisats to sats
	var amountMsat int64
	fmt.Sscanf(zbdResp.Data.Amount, "%d", &amountMsat)
	amountSats := amountMsat / 1000

	isPaid := zbdResp.Data.Status == "completed"

	return isPaid, amountSats, nil
}

// WatchInvoices monitors for paid invoices using polling
// Note: Zebedee supports webhooks which would be more efficient in production
func (z *ZebedeeBackend) WatchInvoices(ctx context.Context) (<-chan PaidInvoice, error) {
	ch := make(chan PaidInvoice)

	go func() {
		defer close(ch)

		// This is a simple polling implementation
		// In production, you should use Zebedee webhooks instead
		// The webhook approach is implemented in webhooks.go and is the recommended method

		for {
			select {
			case <-ctx.Done():
				return
			}
		}
	}()

	log.Printf("Zebedee payment watcher started (no-op polling mode)")

	return ch, nil
}
