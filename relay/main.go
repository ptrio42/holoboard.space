package main

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/fiatjaf/khatru"
	"github.com/nbd-wtf/go-nostr"
)

// loadEnvFile loads environment variables from a .env file if it exists
func loadEnvFile(filename string) error {
	file, err := os.Open(filename)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // .env file is optional
		}
		return err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())

		// Skip empty lines and comments
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		// Parse KEY=VALUE
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}

		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])

		// Remove quotes if present
		value = strings.Trim(value, "\"'")

		// Set environment variable if not already set
		if os.Getenv(key) == "" {
			os.Setenv(key, value)
		}
	}

	return scanner.Err()
}

// getEnv retrieves an environment variable or returns a default value
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func main() {
	// Load .env file if it exists
	if err := loadEnvFile(".env"); err != nil {
		log.Printf("Error loading .env file: %v", err)
	}

	// Configuration
	dataFile := getEnv("DATA_FILE", "relay_data.json")
	portStr := getEnv("PORT", "3334")
	defaultPaymentSatsStr := getEnv("DEFAULT_PAYMENT_SATS", "1000")

	// Parse port
	port, err := strconv.Atoi(portStr)
	if err != nil {
		log.Fatalf("Invalid PORT value: %v", err)
	}

	// Parse default payment sats
	defaultPaymentSats, err := strconv.ParseInt(defaultPaymentSatsStr, 10, 64)
	if err != nil {
		log.Fatalf("Invalid DEFAULT_PAYMENT_SATS value: %v", err)
	}

	// Relay identity
	// In production, load these from environment variables or config file
	relayPrivkey := os.Getenv("RELAY_PRIVKEY")
	if relayPrivkey == "" {
		// Generate a new keypair for demo purposes
		relayPrivkey = nostr.GeneratePrivateKey()
		log.Printf("Generated new relay private key: %s", relayPrivkey)
		log.Printf("IMPORTANT: Set RELAY_PRIVKEY environment variable to persist this key")
	}

	relayPubkey, err := nostr.GetPublicKey(relayPrivkey)
	if err != nil {
		log.Fatalf("Failed to derive public key: %v", err)
	}

	log.Printf("Starting Nostr Promotion Relay")
	log.Printf("Relay pubkey: %s", relayPubkey)

	// Relays to fetch posts from and monitor for zaps
	fetchRelaysStr := getEnv("FETCH_RELAYS", "wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band,wss://nostr.wine")
	fetchRelays := strings.Split(fetchRelaysStr, ",")

	// Trim whitespace from relay URLs
	for i, relay := range fetchRelays {
		fetchRelays[i] = strings.TrimSpace(relay)
	}

	// Initialize storage
	storage, err := NewStorage(dataFile)
	if err != nil {
		log.Fatalf("Failed to initialize storage: %v", err)
	}
	log.Printf("Storage initialized: %d promoted posts loaded", storage.CountPosts())

	// Initialize post fetcher
	fetcher := NewPostFetcher(fetchRelays)

	// Initialize payment monitor
	monitor := NewPaymentMonitor(storage, relayPubkey, fetcher)

	// Initialize Lightning backend based on configuration
	lightningBackend := getEnv("LIGHTNING_BACKEND", "mock")
	var lnBackend LightningBackend

	switch lightningBackend {
	case "zebedee":
		zbdAPIKey := os.Getenv("ZEBEDEE_API_KEY")
		if zbdAPIKey == "" {
			log.Fatalf("ZEBEDEE_API_KEY environment variable required when LIGHTNING_BACKEND=zebedee")
		}
		lnBackend = NewZebedeeBackend(zbdAPIKey)
		log.Printf("Using Zebedee Lightning backend")
	case "lnbits":
		lnbitsAPIKey := os.Getenv("LNBITS_API_KEY")
		lnbitsReadKey := os.Getenv("LNBITS_READ_KEY")
		if lnbitsAPIKey == "" || lnbitsReadKey == "" {
			log.Fatalf("LNBITS_API_KEY and LNBITS_READ_KEY environment variables required when LIGHTNING_BACKEND=lnbits")
		}
		lnbitsBaseURL := getEnv("LNBITS_BASE_URL", "https://legend.lnbits.com")
		lnBackend = NewLNbitsBackend(lnbitsAPIKey, lnbitsReadKey, lnbitsBaseURL)
		log.Printf("Using LNbits Lightning backend at %s", lnbitsBaseURL)
	case "mock":
		lnBackend = NewMockLightningBackend()
		log.Printf("Using mock Lightning backend (for testing only)")
	default:
		log.Fatalf("Unknown LIGHTNING_BACKEND: %s (supported: mock, zebedee, lnbits)", lightningBackend)
	}

	// Initialize invoice manager
	invoiceManager := NewInvoiceManager(lnBackend, storage, monitor, defaultPaymentSats)

	// Start payment watcher
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Initialize SimplePool for mention monitoring
	pool := nostr.NewSimplePool(ctx)

	if err := invoiceManager.StartPaymentWatcher(ctx); err != nil {
		log.Fatalf("Failed to start payment watcher: %v", err)
	}

	// Start zap monitor to listen for zaps on external relays
	zapMonitor := NewZapMonitor(fetchRelays, relayPubkey, monitor)
	if err := zapMonitor.Start(ctx); err != nil {
		log.Fatalf("Failed to start zap monitor: %v", err)
	}

	// Start DM monitor to listen for PROMOTE commands via DM
	dmMonitor := NewDMMonitor(fetchRelays, relayPubkey, relayPrivkey, invoiceManager, storage)
	if err := dmMonitor.Start(ctx); err != nil {
		log.Fatalf("Failed to start DM monitor: %v", err)
	}

	// Start mention monitor to watch for relay pubkey tags (promotional flow)
	mentionMonitor := NewMentionMonitor(relayPubkey, relayPrivkey, storage, fetcher, pool)
	mentionMonitor.Start(ctx, fetchRelays)
	log.Printf("Mention monitor started, watching for @relay mentions")

	// Start periodic cleanup of expired invoices (every hour)
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := storage.CleanupExpiredInvoices(); err != nil {
					log.Printf("Failed to cleanup expired invoices: %v", err)
				}
			}
		}
	}()
	log.Printf("Expired invoice cleanup routine started (runs every hour)")

	// Create khatru relay
	relay := khatru.NewRelay()

	// Setup relay handlers
	config := RelayConfig{
		Name:        "Nostr Promotion Board",
		Description: "A paid promotion relay where posts are ranked by total sats received",
		RelayPubkey: relayPubkey,
		Contact:     "relay@example.com",
		Icon:        "https://example.com/icon.png",
	}

	SetupRelay(relay, storage, monitor, invoiceManager, config)

	// Create and store the info event explaining how to use the relay (only once)
	// Check if we already have an info event from this relay
	hasInfoEvent := false
	storage.mu.RLock()
	for _, post := range storage.posts {
		if post.Event.PubKey == relayPubkey {
			hasInfoEvent = true
			break
		}
	}
	storage.mu.RUnlock()

	if !hasInfoEvent {
		infoEvent, err := CreateInfoEvent(relayPubkey, relayPrivkey)
		if err != nil {
			log.Printf("Failed to create info event: %v", err)
		} else {
			// Add a small initial payment to make the info event visible
			if err := storage.AddPayment(infoEvent.ID, 1, infoEvent); err != nil {
				log.Printf("Failed to store info event: %v", err)
			} else {
				log.Printf("Info event published: %s", infoEvent.ID)
			}
		}
	} else {
		log.Printf("Info event already exists, skipping creation")
	}

	// Start the relay server
	log.Printf("Starting relay on port %d", port)
	log.Printf("WebSocket URL: ws://localhost:%d", port)
	log.Printf("")
	log.Printf("To promote a post:")
	log.Printf("  1. Zap Method: Send a zap to pubkey %s", relayPubkey)
	log.Printf("     Put the event ID (hex, note1..., nevent1..., or nostr:nevent...) in the zap comment")
	log.Printf("  2. DM Method: Send an encrypted DM with command:")
	log.Printf("     PROMOTE <post_id>  (uses default %d sats)", defaultPaymentSats)
	log.Printf("     PROMOTE <amount_sats> <post_id>  (custom amount)")
	log.Printf("Monitoring %d relays: %s", len(fetchRelays), strings.Join(fetchRelays, ", "))
	log.Printf("")

	// Handle graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-sigChan
		log.Printf("Shutting down relay...")
		cancel()
		os.Exit(0)
	}()

	// Start the HTTP server
	log.Printf("Relay is listening on port %d", port)
	if err := relay.Start("0.0.0.0", port); err != nil {
		log.Fatalf("Failed to start relay: %v", err)
	}
}

// Example usage functions for testing

// ExampleZapWorkflow demonstrates the zap payment flow
func ExampleZapWorkflow() {
	// 1. User finds a post they want to promote (post_id = "abc123...")
	postID := "abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab"

	// 2. User creates a zap request (kind:9734)
	_ = &nostr.Event{
		Kind:      9734,
		CreatedAt: nostr.Now(),
		Tags: nostr.Tags{
			{"p", "relay_pubkey"},                    // Relay's pubkey
			{"e", postID},                            // Post to promote
			{"amount", "1000000"},                    // 1000 sats in millisats
			{"relays", "wss://relay.example.com"},    // Where to send zap
		},
		Content: "Promoting this post!",
	}

	// 3. User signs the zap request and sends to their Lightning wallet
	// 4. Wallet generates invoice and user pays
	// 5. Wallet/LNURL server publishes zap receipt (kind:9735)
	// 6. Relay receives the zap receipt, validates it, and promotes the post

	fmt.Printf("Zap workflow for post: %s\n", postID)
}

// ExamplePromoteWorkflow demonstrates the PROMOTE command flow
func ExamplePromoteWorkflow() {
	// 1. User sends DM to relay
	postID := "abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab"
	dmContent := fmt.Sprintf("PROMOTE %s", postID)

	dm := &nostr.Event{
		Kind:      4,
		CreatedAt: nostr.Now(),
		Tags: nostr.Tags{
			{"p", "relay_pubkey"}, // Relay's pubkey
		},
		Content: dmContent, // In real impl, this would be encrypted
	}

	// 2. Relay receives DM, parses command, generates invoice
	// 3. Relay replies with invoice
	// 4. User pays invoice
	// 5. Relay detects payment and promotes the post

	fmt.Printf("PROMOTE workflow: %s\n", dm.Content)
}
