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
	Amount      string `json:"amount"`           // Amount in millisatoshis
	Description string `json:"description"`      // Invoice description/memo
	ExpiresIn   int    `json:"expiresIn"`       // Expiration in seconds
	InternalID  string `json:"internalId"`      // Optional internal reference ID
}

type zbdCreateChargeResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Data    struct {
		ID      string `json:"id"`      // Zebedee charge ID
		Invoice struct {
			Request     string `json:"request"`     // BOLT11 payment request
			ExpiresAt   string `json:"expiresAt"`   // ISO 8601 timestamp
		} `json:"invoice"`
		Amount      string `json:"amount"`      // Amount in millisatoshis
		Status      string `json:"status"`      // pending, completed, expired
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
	log.Printf("IMPORTANT: Configure webhooks via EnableWebhooks() for actual payment notifications")

	return ch, nil
}

// WebhookPayload represents the payload sent by Zebedee webhooks
type WebhookPayload struct {
	ID      string `json:"id"`      // Charge ID
	Status  string `json:"status"`  // completed, expired, etc.
	Amount  string `json:"amount"`  // millisatoshis
	Invoice struct {
		Request string `json:"request"` // BOLT11
	} `json:"invoice"`
	ConfirmedAt string `json:"confirmedAt"` // ISO 8601 timestamp
	InternalID  string `json:"internalId"`
}

// HandleWebhook processes Zebedee webhook callbacks
// This should be called from an HTTP handler
func (z *ZebedeeBackend) HandleWebhook(ctx context.Context, payload []byte) (*PaidInvoice, error) {
	var webhook WebhookPayload
	if err := json.Unmarshal(payload, &webhook); err != nil {
		return nil, fmt.Errorf("failed to unmarshal webhook: %w", err)
	}

	// Only process completed payments
	if webhook.Status != "completed" {
		return nil, nil // Not an error, just not a payment
	}

	// Parse amount
	var amountMsat int64
	fmt.Sscanf(webhook.Amount, "%d", &amountMsat)
	amountSats := amountMsat / 1000

	// Parse confirmed time
	paidAt, err := time.Parse(time.RFC3339, webhook.ConfirmedAt)
	if err != nil {
		log.Printf("Warning: failed to parse confirmation time, using current time: %v", err)
		paidAt = time.Now()
	}

	return &PaidInvoice{
		PaymentHash: webhook.ID, // Use charge ID as payment hash
		AmountSats:  amountSats,
		PaidAt:      paidAt,
	}, nil
}

// SetupZebedeeWebhook configures a webhook URL for payment notifications
// This is a helper function to document how to set up webhooks
func SetupZebedeeWebhook(apiKey, callbackURL string) error {
	// Zebedee webhooks are configured per-charge in the CreateCharge request
	// Or globally via the dashboard at https://dashboard.zebedee.io

	// Example: When creating a charge, add callbackUrl:
	// {
	//   "amount": "1000",
	//   "description": "Test charge",
	//   "callbackUrl": "https://your-relay.com/webhook/zebedee"
	// }

	log.Printf("To use Zebedee webhooks:")
	log.Printf("1. Set up an HTTP endpoint at: %s", callbackURL)
	log.Printf("2. Configure the webhook URL in Zebedee dashboard")
	log.Printf("3. Or pass callbackUrl when creating charges")
	log.Printf("4. Handle webhook POST requests with HandleWebhook()")

	return nil
}
