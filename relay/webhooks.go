package main

import (
	"io"
	"log"
	"net/http"
)

// SetupZebedeeWebhookHandler sets up an HTTP handler for Zebedee payment webhooks
// This provides instant payment notifications instead of polling
func SetupZebedeeWebhookHandler(zbdBackend *ZebedeeBackend, paymentMonitor *PaymentMonitor) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Only accept POST requests
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Read the webhook payload
		body, err := io.ReadAll(r.Body)
		if err != nil {
			log.Printf("Error reading Zebedee webhook body: %v", err)
			http.Error(w, "Bad request", http.StatusBadRequest)
			return
		}
		defer r.Body.Close()

		// Parse and validate the webhook
		paidInvoice, err := zbdBackend.HandleWebhook(r.Context(), body)
		if err != nil {
			log.Printf("Error handling Zebedee webhook: %v", err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		// If this was a payment notification, process it
		if paidInvoice != nil {
			log.Printf("Received Zebedee webhook: payment of %d sats (charge ID: %s)",
				paidInvoice.AmountSats, paidInvoice.PaymentHash)

			if err := paymentMonitor.ProcessInvoicePayment(paidInvoice.PaymentHash, paidInvoice.AmountSats); err != nil {
				log.Printf("Failed to process invoice payment from webhook: %v", err)
				// Still return 200 OK to Zebedee to avoid retries
			} else {
				log.Printf("Successfully processed payment from webhook")
			}
		}

		// Always return 200 OK to acknowledge receipt
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	}
}

// EnableWebhooks adds webhook support to the relay server
// Call this in main.go after setting up the relay
func EnableWebhooks(zbdBackend *ZebedeeBackend, paymentMonitor *PaymentMonitor) {
	http.HandleFunc("/webhook/zebedee", SetupZebedeeWebhookHandler(zbdBackend, paymentMonitor))
	log.Printf("Zebedee webhook endpoint enabled at /webhook/zebedee")
}
