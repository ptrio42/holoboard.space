package main

import (
	"bufio"
	"context"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/fiatjaf/khatru"
	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip19"
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

// splitAndTrim splits a comma separated setting into its non-empty parts.
func splitAndTrim(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
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

	// How often to re-check invoices we are still waiting on
	invoiceCheckSeconds, err := strconv.Atoi(getEnv("INVOICE_CHECK_SECONDS", "60"))
	if err != nil || invoiceCheckSeconds <= 0 {
		log.Fatalf("Invalid INVOICE_CHECK_SECONDS value: %s", getEnv("INVOICE_CHECK_SECONDS", "60"))
	}
	invoiceCheckInterval := time.Duration(invoiceCheckSeconds) * time.Second

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

	// Which LNURL servers are allowed to say this relay was paid. The
	// addresses are handed over at Start, once the profile and the Lightning
	// backend have been read.
	zapValidator := NewLNURLResolver()

	// Initialize payment monitor
	monitor := NewPaymentMonitor(storage, relayPubkey, fetcher, zapValidator)

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
	case "nwc":
		nwcURI := os.Getenv("NWC_URI")
		if nwcURI == "" {
			log.Fatalf("NWC_URI environment variable required when LIGHTNING_BACKEND=nwc")
		}
		nwcBackend, err := ParseNWCURI(nwcURI)
		if err != nil {
			log.Fatalf("Invalid NWC_URI: %v", err)
		}
		// Ask the wallet what it supports before anything requests an invoice.
		// A wallet that publishes no info event still works; it just means
		// NIP-04 encryption and no notifications, so settlement gets picked up
		// by the reconciler below instead.
		infoCtx, cancelInfo := context.WithTimeout(context.Background(), 30*time.Second)
		if err := nwcBackend.LoadInfo(infoCtx); err != nil {
			log.Printf("Could not read NWC wallet info, continuing with defaults: %v", err)
		}
		cancelInfo()
		lnBackend = nwcBackend
		log.Printf("Using NWC Lightning backend via %s", nwcBackend.relayURL)
		if addr := nwcBackend.LightningAddress(); addr != "" {
			log.Printf("Wallet Lightning address (for zaps): %s", addr)
		}
	case "mock":
		lnBackend = NewMockLightningBackend()
		log.Printf("Using mock Lightning backend (for testing only)")
	default:
		log.Fatalf("Unknown LIGHTNING_BACKEND: %s (supported: mock, nwc, lnbits, zebedee)", lightningBackend)
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

	// The watcher above only fires when the backend pushes settlements at us.
	// The reconciler covers the rest: invoices paid while the relay was down,
	// and backends that never push anything at all.
	invoiceManager.StartInvoiceReconciler(ctx, invoiceCheckInterval)

	// Start zap monitor to listen for zaps on external relays
	zapMonitor := NewZapMonitor(fetchRelays, relayPubkey, monitor)
	if err := zapMonitor.Start(ctx); err != nil {
		log.Fatalf("Failed to start zap monitor: %v", err)
	}

	// Start DM monitor to listen for PROMOTE commands via DM
	// One pubkey may take a note off the board, by DM. Accepts an npub or hex;
	// an unparseable value is fatal rather than silently leaving nobody in
	// charge, because that failure would only show up when it mattered.
	adminPubkey := ""
	if configured := getEnv("ADMIN_PUBKEY", ""); configured != "" {
		resolved, err := normalizePubkey(configured)
		if err != nil {
			log.Fatalf("Invalid ADMIN_PUBKEY: %v", err)
		}
		adminPubkey = resolved
		log.Printf("Admin pubkey: %s", short(adminPubkey, 8))
	}

	dmMonitor := NewDMMonitor(fetchRelays, relayPubkey, relayPrivkey, invoiceManager, storage).
		WithAdmin(adminPubkey)
	if err := dmMonitor.Start(ctx); err != nil {
		log.Fatalf("Failed to start DM monitor: %v", err)
	}

	// Tell clients where to deliver a gift wrap. Without a kind:10050 a NIP-17
	// client has to guess, and the usual guess is the recipient's write relays,
	// which for a relay that publishes almost nothing is nowhere useful.
	go publishRelayLists(ctx, relayPrivkey, fetchRelays)

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

	// The relay already has an identity on nostr, so read it from there rather
	// than keeping a second copy in configuration that drifts. Both fields stay
	// overridable for anyone running their own instance.
	profileStart := time.Now()
	profile := fetchRelayProfile(ctx, fetchRelays, relayPubkey)
	log.Printf("Relay profile lookup took %s", time.Since(profileStart).Round(time.Millisecond))

	// Contact is the relay's own npub. An email address here was never real,
	// and the npub is derived, so it cannot go stale.
	contact := getEnv("RELAY_CONTACT", "")
	if contact == "" {
		if npub, err := nip19.EncodePublicKey(relayPubkey); err == nil {
			contact = npub
		} else {
			log.Printf("Could not encode relay npub for NIP-11 contact: %v", err)
		}
	}

	icon := getEnv("RELAY_ICON", "")
	if icon == "" && profile != nil {
		icon = profile.Picture
	}

	name := getEnv("RELAY_NAME", "")
	if name == "" && profile != nil {
		name = profile.Name
	}
	if name == "" {
		name = "Nostr Promotion Board"
	}

	// Now that both the profile and the Lightning backend are known, tell the
	// zap validator which LNURL servers are allowed to say this relay was paid.
	//
	// The default is the address on the relay's own kind:0, because that is the
	// one a zapping client resolves and pays. The NWC wallet's address is added
	// when it differs, which here it does: the profile advertises one wallet
	// and the connection string points at another.
	zapAddresses := splitAndTrim(getEnv("ZAP_LNURL_ADDRESSES", ""))
	if len(zapAddresses) == 0 && profile != nil {
		zapAddresses = splitAndTrim(profile.Lud16)
	}
	if nwc, ok := lnBackend.(*NWCBackend); ok {
		zapAddresses = append(zapAddresses, nwc.LightningAddress())
	}
	zapValidator.Start(ctx, zapAddresses)

	if profile != nil {
		log.Printf("Relay profile loaded from nostr: name %q, lud16 %q", profile.Name, profile.Lud16)
	} else {
		log.Printf("No kind:0 profile found for this relay; NIP-11 icon will be empty")
	}

	// Setup relay handlers
	config := RelayConfig{
		Name:        name,
		Description: getEnv("RELAY_DESCRIPTION", "A paid promotion relay where posts are ranked by total sats received"),
		RelayPubkey: relayPubkey,
		Contact:     contact,
		Icon:        icon,
	}

	SetupRelay(relay, storage, monitor, invoiceManager, config)

	// Push newly promoted notes to whoever is already subscribed. khatru has
	// BroadcastEvent for exactly this and nothing was calling it, so a note only
	// showed up after the page was reloaded.
	monitor.SetBroadcaster(relay.BroadcastEvent)

	// The ledger the board is ranked by. Events are signed over their tags, so
	// the sats total cannot ride along on the notes themselves; this is how it
	// reaches clients. khatru dispatches on headers, never on path, so a plain
	// JSON route cannot collide with the websocket or the NIP-11 document, and
	// Start() already wraps everything in permissive CORS for GET.
	relay.Router().HandleFunc("/api/board", BoardHandler(storage))
	log.Printf("Board ledger served at /api/board")

	// Promoting without an identity. The relay never cared who mentioned it, so
	// requiring a signer on the website was never a product requirement, only a
	// consequence of the website automating the mention flow.
	relay.Router().HandleFunc("/api/promote", PromoteHandler(storage, invoiceManager, fetcher))
	relay.Router().HandleFunc("/api/promote/status", PromoteStatusHandler(storage, invoiceManager))
	log.Printf("No-login promotion served at /api/promote")

	// Taking a note down. Registered only when a token exists, so a relay run
	// without one has no such endpoint at all rather than one guarded by an
	// empty string.
	if adminToken := getEnv("ADMIN_TOKEN", ""); adminToken != "" {
		relay.Router().HandleFunc("/api/admin/note", AdminHandler(storage, adminToken))
		log.Printf("Operator note removal served at /api/admin/note")
	} else {
		log.Printf("ADMIN_TOKEN is unset, so there is no way to take a note off the board")
	}

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

		// Stop the monitors first, so nothing new lands in storage while we
		// are trying to leave the ledger in a settled state.
		cancel()

		shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelShutdown()
		relay.Shutdown(shutdownCtx)

		// Wait out any save already in flight. Writes are atomic, so the file
		// on disk is never torn, but exiting here without waiting could still
		// drop a payment recorded a moment ago.
		storage.Quiesce()

		log.Printf("Shutdown complete")
		os.Exit(0)
	}()

	// Start the HTTP server
	log.Printf("Relay is listening on port %d", port)
	if err := relay.Start("0.0.0.0", port); err != nil {
		log.Fatalf("Failed to start relay: %v", err)
	}
}
