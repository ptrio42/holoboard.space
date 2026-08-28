# Zebedee Lightning Integration

This guide explains how to integrate Zebedee for Lightning invoice generation and payment reception.

## What is Zebedee?

Zebedee (ZBD) is a Lightning Network service provider that offers an API for creating invoices, receiving payments, and managing Lightning wallets without running your own node.

## Setup Instructions

### 1. Get a Zebedee API Key

1. Sign up at [https://dashboard.zebedee.io](https://dashboard.zebedee.io)
2. Create a new project
3. Generate an API key from the dashboard
4. Copy your API key

### 2. Configure Environment Variables

Create or edit your `.env` file:

```bash
# Set Lightning backend to zebedee
LIGHTNING_BACKEND=zebedee

# Add your Zebedee API key
ZEBEDEE_API_KEY=your_zebedee_api_key_here

# Optional: Set a webhook URL for instant payment notifications
ZEBEDEE_WEBHOOK_URL=https://your-relay-domain.com/webhook/zebedee
```

### 3. Payment Flow Options

Zebedee supports two methods for receiving payment notifications:

#### Option A: Polling (Simple, works immediately)

The current implementation uses polling to check invoice status every 10 seconds. This works out of the box but has a delay.

No additional setup needed - just start the relay and it will work.

#### Option B: Webhooks (Recommended for production)

Webhooks provide instant payment notifications. To set this up:

1. **Set up a public endpoint**: Your relay needs to be accessible from the internet
2. **Create a webhook handler** in your relay (example below)
3. **Configure the webhook URL** in your Zebedee dashboard or via API

Example webhook handler to add to your relay:

```go
// Add this to your main.go or create a new webhooks.go file
func setupWebhookHandler(relay *khatru.Relay, zbdBackend *ZebedeeBackend, invoiceManager *InvoiceManager) {
    http.HandleFunc("/webhook/zebedee", func(w http.ResponseWriter, r *http.Request) {
        if r.Method != "POST" {
            http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
            return
        }

        body, err := io.ReadAll(r.Body)
        if err != nil {
            log.Printf("Error reading webhook body: %v", err)
            http.Error(w, "Bad request", http.StatusBadRequest)
            return
        }

        paidInvoice, err := zbdBackend.HandleWebhook(r.Context(), body)
        if err != nil {
            log.Printf("Error handling webhook: %v", err)
            http.Error(w, "Internal server error", http.StatusInternalServerError)
            return
        }

        if paidInvoice != nil {
            // Process the payment
            if err := invoiceManager.paymentMonitor.ProcessInvoicePayment(paidInvoice.PaymentHash, paidInvoice.AmountSats); err != nil {
                log.Printf("Failed to process invoice payment: %v", err)
            }
        }

        w.WriteHeader(http.StatusOK)
        w.Write([]byte("OK"))
    })
}
```

Then call it in your main() function:

```go
// After creating the relay and before starting it
if lightningBackend == "zebedee" {
    webhookURL := os.Getenv("ZEBEDEE_WEBHOOK_URL")
    if webhookURL != "" {
        setupWebhookHandler(relay, lnBackend.(*ZebedeeBackend), invoiceManager)
        log.Printf("Zebedee webhook handler configured at /webhook/zebedee")
        log.Printf("Make sure to configure this URL in Zebedee dashboard: %s", webhookURL)
    }
}
```

### 4. Test the Integration

1. Start your relay:
```bash
go run .
```

2. Generate a test invoice using the PROMOTE command (send a DM to the relay)

3. Pay the invoice using any Lightning wallet

4. Watch the logs to see the payment being processed

## API Rate Limits

Zebedee has rate limits on their API:
- Free tier: 100 requests per minute
- Production tier: Higher limits available

For production use with high volume, consider:
- Using webhooks instead of polling
- Implementing proper rate limiting in your code
- Upgrading to a paid Zebedee plan

## Production Checklist

- [ ] Get a production Zebedee API key
- [ ] Set up webhooks for instant payment notifications
- [ ] Secure your webhook endpoint (verify signatures if Zebedee provides them)
- [ ] Set up proper error handling and retry logic
- [ ] Monitor API usage and stay within rate limits
- [ ] Set up logging and alerts for failed payments
- [ ] Test with real payments in a staging environment first

## Troubleshooting

### "ZEBEDEE_API_KEY environment variable required"
Make sure you've set the ZEBEDEE_API_KEY in your .env file.

### "zebedee API error (status 401)"
Your API key is invalid or expired. Get a new one from the Zebedee dashboard.

### "zebedee API error (status 429)"
You've hit the rate limit. Wait a minute or upgrade your plan.

### Payments not being detected
- If using polling: Wait up to 10 seconds for the next poll
- If using webhooks: Check that your webhook URL is publicly accessible and configured correctly in Zebedee

## Alternative: Other Lightning Providers

If you prefer a different provider, you can implement the `LightningBackend` interface for:
- **Strike**: Similar to Zebedee, offers API for Lightning payments
- **OpenNode**: Another Lightning service provider with API
- **LND/CLN**: Run your own Lightning node (more control, more complexity)

## Resources

- [Zebedee API Documentation](https://docs.zebedee.io/)
- [Zebedee Dashboard](https://dashboard.zebedee.io)
- [Zebedee API Reference](https://api.zebedee.io/docs)
