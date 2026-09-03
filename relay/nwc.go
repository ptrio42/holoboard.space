package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip04"
	"github.com/nbd-wtf/go-nostr/nip44"
)

// NWCBackend talks to a Lightning wallet over Nostr Wallet Connect.
//
// Spec: NIP-47 for the core protocol
// (https://github.com/nostr-protocol/nips/blob/master/47.md) and NWC-02 for
// notifications (https://github.com/nostr-wallet-connect/nwc/blob/master/02.md).
//
// NWC sits between this relay and its own wallet, never between the relay and
// whoever pays. make_invoice hands back an ordinary bolt11 that any wallet can
// pay, so nobody on the paying side needs to know Nostr Wallet Connect exists.
// The point of going through NWC rather than a vendor HTTP API is that the same
// three calls work against every NWC wallet, so switching provider is a change
// of connection string rather than a change of code.
type NWCBackend struct {
	walletPubkey string
	relayURL     string
	secret       string // client private key, hex
	clientPubkey string
	lud16        string

	mu            sync.Mutex
	encryption    string // negotiated scheme: encNIP44 or encNIP04
	methods       []string
	notifications []string
	infoLoaded    bool
}

// NIP-47 event kinds. Requests and responses are ephemeral, so relays pass them
// through to live subscriptions without storing them; the info event is
// replaceable and does get stored.
const (
	nwcKindInfo              = 13194
	nwcKindRequest           = 23194
	nwcKindResponse          = 23195
	nwcKindNotificationNIP04 = 23196
	nwcKindNotificationNIP44 = 23197
)

const (
	encNIP44 = "nip44_v2"
	encNIP04 = "nip04"
)

// nwcRequestTimeout caps how long a single command waits for its reply when the
// caller's context has no deadline of its own.
const nwcRequestTimeout = 30 * time.Second

// nwcInvoiceExpiry is what we ask for on new invoices, and the fallback used
// when a wallet answers without an expires_at. Never leave this at the zero
// time: CleanupExpiredInvoices treats a zero expiry as long past due and would
// drop the invoice on its next hourly pass.
const nwcInvoiceExpiry = 1 * time.Hour

// ParseNWCURI builds a backend from a nostr+walletconnect:// connection string.
//
//	nostr+walletconnect://<wallet-pubkey-hex>?relay=<wss url>&secret=<hex>&lud16=<address>
func ParseNWCURI(uri string) (*NWCBackend, error) {
	trimmed := strings.TrimSpace(uri)
	if trimmed == "" {
		return nil, fmt.Errorf("empty NWC connection string")
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		// Deliberately not wrapping err. url.Parse puts the whole input in its
		// error message, and the input carries the wallet secret, so wrapping
		// it would print the secret through main.go's log.Fatalf and straight
		// into the host's log stream.
		return nil, fmt.Errorf("NWC connection string is not a valid URI")
	}

	if scheme := strings.ToLower(parsed.Scheme); scheme != "nostr+walletconnect" {
		return nil, fmt.Errorf("unexpected scheme %q, want nostr+walletconnect", parsed.Scheme)
	}

	// The wallet pubkey sits where a host would normally go, but some wallets
	// hand out the opaque form (nostr+walletconnect:<pubkey>?...) instead.
	walletPubkey := parsed.Host
	if walletPubkey == "" {
		walletPubkey = strings.TrimPrefix(parsed.Opaque, "//")
	}
	walletPubkey = strings.ToLower(strings.Trim(walletPubkey, "/"))
	if !isHex64(walletPubkey) {
		return nil, fmt.Errorf("wallet pubkey is not 64 hex characters")
	}

	query := parsed.Query()

	relayURL := strings.TrimSpace(query.Get("relay"))
	if relayURL == "" {
		return nil, fmt.Errorf("connection string has no relay parameter")
	}

	secret := strings.ToLower(strings.TrimSpace(query.Get("secret")))
	if !isHex64(secret) {
		return nil, fmt.Errorf("secret is not 64 hex characters")
	}

	clientPubkey, err := nostr.GetPublicKey(secret)
	if err != nil {
		return nil, fmt.Errorf("failed to derive client pubkey from secret: %w", err)
	}

	return &NWCBackend{
		walletPubkey: walletPubkey,
		relayURL:     relayURL,
		secret:       secret,
		clientPubkey: clientPubkey,
		lud16:        query.Get("lud16"),
		// Absent an info event saying otherwise, NIP-47 says assume NIP-04.
		encryption: encNIP04,
	}, nil
}

// isHex64 reports whether s is exactly 64 lowercase-or-uppercase hex digits.
func isHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		switch {
		case c >= '0' && c <= '9':
		case c >= 'a' && c <= 'f':
		case c >= 'A' && c <= 'F':
		default:
			return false
		}
	}
	return true
}

// LightningAddress returns the lud16 from the connection string, if it carried
// one. Useful for the zap flows, which need a Lightning address rather than an
// invoice API.
func (b *NWCBackend) LightningAddress() string { return b.lud16 }

// LoadInfo fetches the wallet's info event to learn which encryption scheme,
// commands and notifications it supports. Safe to call more than once; only the
// first successful call does any work.
//
// A wallet that publishes no info event is not an error. NIP-47 says an absent
// encryption tag means NIP-04, which is what the backend already defaults to.
func (b *NWCBackend) LoadInfo(ctx context.Context) error {
	b.mu.Lock()
	if b.infoLoaded {
		b.mu.Unlock()
		return nil
	}
	b.mu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, nwcRequestTimeout)
	defer cancel()

	relay, err := nostr.RelayConnect(ctx, b.relayURL)
	if err != nil {
		return fmt.Errorf("failed to connect to wallet relay %s: %w", b.relayURL, err)
	}
	defer relay.Close()

	events, err := relay.QuerySync(ctx, nostr.Filter{
		Kinds:   []int{nwcKindInfo},
		Authors: []string{b.walletPubkey},
		Limit:   1,
	})
	if err != nil {
		return fmt.Errorf("failed to query wallet info event: %w", err)
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	b.infoLoaded = true

	if len(events) == 0 {
		log.Printf("NWC: wallet published no info event, assuming %s and no notifications", encNIP04)
		return nil
	}

	info := events[0]
	b.methods = strings.Fields(info.Content)

	for _, tag := range info.Tags {
		if len(tag) < 2 {
			continue
		}
		switch tag[0] {
		case "encryption":
			for _, scheme := range strings.Fields(tag[1]) {
				// Prefer nip44 whenever the wallet offers it; nip04 is deprecated.
				if scheme == encNIP44 {
					b.encryption = encNIP44
				}
			}
		case "notifications":
			b.notifications = strings.Fields(tag[1])
		}
	}

	log.Printf("NWC: wallet supports methods [%s], notifications [%s], using %s",
		strings.Join(b.methods, " "), strings.Join(b.notifications, " "), b.encryption)
	return nil
}

// SupportsNotifications reports whether the wallet advertised payment_received.
// When it does not, settlement has to be discovered by polling instead; see
// InvoiceManager.StartInvoiceReconciler.
func (b *NWCBackend) SupportsNotifications() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, n := range b.notifications {
		if n == "payment_received" {
			return true
		}
	}
	return false
}

func (b *NWCBackend) encryptionScheme() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.encryption
}

// encryptFor seals plaintext for the wallet using the given scheme.
func (b *NWCBackend) encryptFor(scheme, plaintext string) (string, error) {
	if scheme == encNIP44 {
		key, err := nip44.GenerateConversationKey(b.walletPubkey, b.secret)
		if err != nil {
			return "", fmt.Errorf("failed to derive nip44 conversation key: %w", err)
		}
		return nip44Encrypt(plaintext, key)
	}

	key, err := nip04.ComputeSharedSecret(b.walletPubkey, b.secret)
	if err != nil {
		return "", fmt.Errorf("failed to derive nip04 shared secret: %w", err)
	}
	return nip04.Encrypt(plaintext, key)
}

// nip44Encrypt seals plaintext under a freshly generated nonce.
//
// go-nostr v0.34.5 cannot generate one itself. nip44.Encrypt means to fill in a
// random nonce when the caller passes none, but the variable it fills is
// shadowed by a second := inside the if, so the outer nonce stays nil and
// messageKeys rejects it with "nonce must be 32 bytes". Supplying our own is
// the library's documented escape hatch and does exactly what it intended.
func nip44Encrypt(plaintext string, conversationKey []byte) (string, error) {
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("failed to generate nip44 nonce: %w", err)
	}
	return nip44.Encrypt(plaintext, conversationKey, nip44.WithCustomNonce(nonce))
}

// decryptFrom opens ciphertext that the wallet sealed with the given scheme.
func (b *NWCBackend) decryptFrom(scheme, ciphertext string) (string, error) {
	if scheme == encNIP44 {
		key, err := nip44.GenerateConversationKey(b.walletPubkey, b.secret)
		if err != nil {
			return "", fmt.Errorf("failed to derive nip44 conversation key: %w", err)
		}
		return nip44.Decrypt(ciphertext, key)
	}

	key, err := nip04.ComputeSharedSecret(b.walletPubkey, b.secret)
	if err != nil {
		return "", fmt.Errorf("failed to derive nip04 shared secret: %w", err)
	}
	return nip04.Decrypt(ciphertext, key)
}

// nwcResponse is the envelope every reply arrives in.
type nwcResponse struct {
	ResultType string          `json:"result_type"`
	Error      *nwcError       `json:"error"`
	Result     json.RawMessage `json:"result"`
}

type nwcError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *nwcError) Error() string {
	return fmt.Sprintf("wallet returned %s: %s", e.Code, e.Message)
}

// nwcTransaction is the shared result shape of make_invoice, lookup_invoice and
// the payment_received notification. Amounts are in millisats throughout.
type nwcTransaction struct {
	Type        string `json:"type"`
	State       string `json:"state"`
	Invoice     string `json:"invoice"`
	Description string `json:"description"`
	Preimage    string `json:"preimage"`
	PaymentHash string `json:"payment_hash"`
	Amount      int64  `json:"amount"`
	FeesPaid    int64  `json:"fees_paid"`
	CreatedAt   int64  `json:"created_at"`
	ExpiresAt   int64  `json:"expires_at"`
	SettledAt   int64  `json:"settled_at"`

	// Status is not in the spec, but Coinos fills it in alongside State, so
	// take it as a third signal rather than depending on any one field.
	Status string `json:"status"`
}

// settled reports whether this transaction has actually been paid. Wallets
// disagree about which field carries that, so accept any of the three.
func (t *nwcTransaction) settled() bool {
	return t.SettledAt > 0 || t.State == "settled" || t.Status == "settled"
}

// nwcNotification is the envelope notifications arrive in (NWC-02).
type nwcNotification struct {
	NotificationType string          `json:"notification_type"`
	Notification     json.RawMessage `json:"notification"`
}

// request sends one NIP-47 command and decodes the reply into result.
//
// Each call gets its own short-lived connection. Commands are rare here, one
// per PROMOTE DM, so the cost of a fresh websocket is not worth the stale
// connection bugs that a shared long-lived one invites. WatchInvoices, which
// genuinely needs to stay connected, keeps its own.
func (b *NWCBackend) request(ctx context.Context, method string, params any, result any) error {
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, nwcRequestTimeout)
		defer cancel()
	}

	payload, err := json.Marshal(map[string]any{"method": method, "params": params})
	if err != nil {
		return fmt.Errorf("failed to marshal %s request: %w", method, err)
	}

	scheme := b.encryptionScheme()
	content, err := b.encryptFor(scheme, string(payload))
	if err != nil {
		return fmt.Errorf("failed to encrypt %s request: %w", method, err)
	}

	req := nostr.Event{
		PubKey:    b.clientPubkey,
		CreatedAt: nostr.Now(),
		Kind:      nwcKindRequest,
		Tags:      nostr.Tags{{"p", b.walletPubkey}},
		Content:   content,
	}
	if scheme == encNIP44 {
		req.Tags = append(req.Tags, nostr.Tag{"encryption", encNIP44})
	}
	if err := req.Sign(b.secret); err != nil {
		return fmt.Errorf("failed to sign %s request: %w", method, err)
	}

	relay, err := nostr.RelayConnect(ctx, b.relayURL)
	if err != nil {
		return fmt.Errorf("failed to connect to wallet relay %s: %w", b.relayURL, err)
	}
	defer relay.Close()

	// Subscribe before publishing. A wallet can answer faster than we could
	// open a subscription afterwards, and the reply is ephemeral, so missing it
	// means it is gone for good.
	sub, err := relay.Subscribe(ctx, nostr.Filters{{
		Kinds:   []int{nwcKindResponse},
		Authors: []string{b.walletPubkey},
		Tags:    nostr.TagMap{"e": []string{req.ID}, "p": []string{b.clientPubkey}},
	}})
	if err != nil {
		return fmt.Errorf("failed to subscribe for %s response: %w", method, err)
	}
	defer sub.Unsub()

	if err := relay.Publish(ctx, req); err != nil {
		return fmt.Errorf("failed to publish %s request: %w", method, err)
	}

	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("timed out waiting for %s response: %w", method, ctx.Err())

		case evt, ok := <-sub.Events:
			if !ok {
				return fmt.Errorf("subscription closed while waiting for %s response", method)
			}
			if evt == nil || evt.PubKey != b.walletPubkey {
				continue
			}

			plaintext, err := b.decryptFrom(responseScheme(evt, scheme), evt.Content)
			if err != nil {
				return fmt.Errorf("failed to decrypt %s response: %w", method, err)
			}

			var envelope nwcResponse
			if err := json.Unmarshal([]byte(plaintext), &envelope); err != nil {
				return fmt.Errorf("failed to parse %s response: %w", method, err)
			}
			if envelope.Error != nil && envelope.Error.Code != "" {
				return envelope.Error
			}
			if result == nil {
				return nil
			}
			if len(envelope.Result) == 0 {
				return fmt.Errorf("%s response carried no result", method)
			}
			if err := json.Unmarshal(envelope.Result, result); err != nil {
				return fmt.Errorf("failed to parse %s result: %w", method, err)
			}
			return nil
		}
	}
}

// responseScheme picks the scheme to decrypt an incoming event with. A wallet
// states it on the event when it deviates from what we asked for.
func responseScheme(evt *nostr.Event, fallback string) string {
	for _, tag := range evt.Tags {
		if len(tag) >= 2 && tag[0] == "encryption" {
			if tag[1] == encNIP44 {
				return encNIP44
			}
			return encNIP04
		}
	}
	if evt.Kind == nwcKindNotificationNIP44 {
		return encNIP44
	}
	if evt.Kind == nwcKindNotificationNIP04 {
		return encNIP04
	}
	return fallback
}

// GenerateInvoice asks the wallet for a bolt11 invoice.
func (b *NWCBackend) GenerateInvoice(ctx context.Context, amountSats int64, memo string) (*Invoice, error) {
	if amountSats <= 0 {
		return nil, fmt.Errorf("invoice amount must be positive, got %d", amountSats)
	}

	var tx nwcTransaction
	err := b.request(ctx, "make_invoice", map[string]any{
		"amount":      amountSats * 1000, // NIP-47 amounts are millisats
		"description": memo,
		"expiry":      int64(nwcInvoiceExpiry / time.Second),
	}, &tx)
	if err != nil {
		return nil, err
	}

	if tx.Invoice == "" {
		return nil, fmt.Errorf("wallet returned no invoice")
	}
	if tx.PaymentHash == "" {
		return nil, fmt.Errorf("wallet returned no payment hash")
	}

	// Trust our own request over a wallet that echoes nothing back.
	settledAmount := tx.Amount / 1000
	if settledAmount <= 0 {
		settledAmount = amountSats
	}

	expiresAt := time.Now().Add(nwcInvoiceExpiry)
	if tx.ExpiresAt > 0 {
		expiresAt = time.Unix(tx.ExpiresAt, 0)
	}

	log.Printf("NWC: created invoice %s for %d sats", short(tx.PaymentHash, 12), settledAmount)

	return &Invoice{
		PaymentRequest: tx.Invoice,
		PaymentHash:    tx.PaymentHash,
		AmountSats:     settledAmount,
		ExpiresAt:      expiresAt,
	}, nil
}

// CheckInvoice asks the wallet whether one invoice has been paid. This is what
// lets the relay reconcile invoices it slept through: paid while the process
// was down, or while its connection to the wallet was.
//
// Treat the returned amount as advisory and never book payment on it. Coinos,
// for one, omits the amount field entirely from a lookup_invoice reply while
// the invoice is still pending, so this returns 0 for it. The amount an invoice
// was issued for is the one already in storage, and that is what
// InvoiceManager.reconcilePendingInvoices credits.
func (b *NWCBackend) CheckInvoice(ctx context.Context, paymentHash string) (bool, int64, error) {
	if paymentHash == "" {
		return false, 0, fmt.Errorf("payment hash is empty")
	}

	var tx nwcTransaction
	err := b.request(ctx, "lookup_invoice", map[string]any{
		"payment_hash": paymentHash,
	}, &tx)
	if err != nil {
		return false, 0, err
	}

	return tx.settled(), tx.Amount / 1000, nil
}

// WatchInvoices streams settlements as the wallet notifies about them.
//
// When the wallet advertises no payment_received notification the returned
// channel stays silent, and reconciliation is left to
// InvoiceManager.StartInvoiceReconciler polling CheckInvoice.
func (b *NWCBackend) WatchInvoices(ctx context.Context) (<-chan PaidInvoice, error) {
	ch := make(chan PaidInvoice)

	if !b.SupportsNotifications() {
		log.Printf("NWC: wallet advertises no payment_received notification, " +
			"settlement will be picked up by polling instead")
		go func() {
			<-ctx.Done()
			close(ch)
		}()
		return ch, nil
	}

	go b.watchLoop(ctx, ch)
	return ch, nil
}

// watchLoop keeps a subscription to the wallet's notifications alive, standing
// the connection back up whenever it drops.
//
// The inner loop exits on a closed Events channel rather than looping on it.
// Reading from a closed channel returns instantly and forever, so treating that
// as "nothing to do, carry on" spins a core at full tilt and silently stops
// delivering anything, which is exactly how ZapMonitor used to fail.
func (b *NWCBackend) watchLoop(ctx context.Context, ch chan PaidInvoice) {
	defer close(ch)

	const (
		minBackoff = 2 * time.Second
		maxBackoff = 60 * time.Second
	)
	backoff := minBackoff

	for {
		if ctx.Err() != nil {
			return
		}

		reconnectIn := b.watchOnce(ctx, ch)
		if ctx.Err() != nil {
			return
		}

		if reconnectIn {
			// The subscription ran for a while before dropping, so treat the
			// wallet relay as healthy and retry promptly.
			backoff = minBackoff
		}

		log.Printf("NWC: notification stream dropped, reconnecting in %s", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}

		if backoff < maxBackoff {
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
		}
	}
}

// watchOnce holds one connection open until it fails. It reports whether the
// subscription delivered anything before dying, which the caller uses to decide
// how hard to back off.
func (b *NWCBackend) watchOnce(ctx context.Context, ch chan PaidInvoice) (delivered bool) {
	relay, err := nostr.RelayConnect(ctx, b.relayURL)
	if err != nil {
		log.Printf("NWC: failed to connect to wallet relay %s: %v", b.relayURL, err)
		return false
	}
	defer relay.Close()

	since := nostr.Now()
	sub, err := relay.Subscribe(ctx, nostr.Filters{{
		Kinds:   []int{nwcKindNotificationNIP04, nwcKindNotificationNIP44},
		Authors: []string{b.walletPubkey},
		Tags:    nostr.TagMap{"p": []string{b.clientPubkey}},
		Since:   &since,
	}})
	if err != nil {
		log.Printf("NWC: failed to subscribe for notifications: %v", err)
		return false
	}
	defer sub.Unsub()

	log.Printf("NWC: watching %s for payment notifications", b.relayURL)

	for {
		select {
		case <-ctx.Done():
			return delivered

		case evt, ok := <-sub.Events:
			if !ok {
				return delivered
			}
			if evt == nil || evt.PubKey != b.walletPubkey {
				continue
			}

			paid, err := b.parsePaymentNotification(evt)
			if err != nil {
				log.Printf("NWC: ignoring notification %s: %v", short(evt.ID, 8), err)
				continue
			}
			if paid == nil {
				continue // a notification we do not care about, such as payment_sent
			}

			delivered = true
			select {
			case ch <- *paid:
			case <-ctx.Done():
				return delivered
			}
		}
	}
}

// parsePaymentNotification turns a notification event into a PaidInvoice.
// It returns a nil invoice and a nil error for notification types other than
// payment_received.
func (b *NWCBackend) parsePaymentNotification(evt *nostr.Event) (*PaidInvoice, error) {
	plaintext, err := b.decryptFrom(responseScheme(evt, b.encryptionScheme()), evt.Content)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt: %w", err)
	}

	var envelope nwcNotification
	if err := json.Unmarshal([]byte(plaintext), &envelope); err != nil {
		return nil, fmt.Errorf("failed to parse envelope: %w", err)
	}
	if envelope.NotificationType != "payment_received" {
		return nil, nil
	}

	var tx nwcTransaction
	if err := json.Unmarshal(envelope.Notification, &tx); err != nil {
		return nil, fmt.Errorf("failed to parse payment_received body: %w", err)
	}
	if tx.PaymentHash == "" {
		return nil, fmt.Errorf("payment_received carried no payment hash")
	}

	paidAt := time.Now()
	if tx.SettledAt > 0 {
		paidAt = time.Unix(tx.SettledAt, 0)
	}

	return &PaidInvoice{
		PaymentHash: tx.PaymentHash,
		AmountSats:  tx.Amount / 1000,
		PaidAt:      paidAt,
	}, nil
}
