package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"fiatjaf.com/nostr"
)

// DiscoveryReward is private durable state. Public feeds expose a separate view.
// A sending/uncertain record is a reservation, including after midnight or expiry.
type DiscoveryReward struct {
	Status         string       `json:"status"`
	AmountSats     int64        `json:"amount_sats"`
	Invoice        string       `json:"invoice,omitempty"`
	PaymentHash    string       `json:"payment_hash,omitempty"`
	Recipient      string       `json:"recipient,omitempty"`
	ProviderPubkey string       `json:"provider_pubkey,omitempty"`
	WalletID       string       `json:"wallet_id,omitempty"`
	ZapRequest     *nostr.Event `json:"zap_request,omitempty"`
	PreparedAt     time.Time    `json:"prepared_at,omitempty"`
	AttemptedAt    time.Time    `json:"attempted_at,omitempty"`
	SettledAt      time.Time    `json:"settled_at,omitempty"`
	LastCheckedAt  time.Time    `json:"last_checked_at,omitempty"`
	RetryAfter     time.Time    `json:"retry_after,omitempty"`
	FeesPaidMsat   *int64       `json:"fees_paid_msat,omitempty"`
	LastError      string       `json:"last_error,omitempty"`
}

type DiscoveryWalletResult struct {
	State        string
	PaymentHash  string
	AmountMsat   int64
	Preimage     string
	FeesPaidMsat *int64
}

// DiscoveryWallet is deliberately separate from the receiving LightningBackend.
// Identity binds recovery to the connection that actually initiated the payment.
type DiscoveryWallet interface {
	Identity() string
	Ready(context.Context) error
	Pay(context.Context, string) (DiscoveryWalletResult, error)
	Lookup(context.Context, string) (DiscoveryWalletResult, error)
}

type discoveryRewardStore interface {
	GetDiscovery(string) (*Discovery, bool)
	DiscoveriesForRewards() []*Discovery
	UpdateDiscoveryReward(string, func(*DiscoveryReward) error) error
	DiscoverySpendingAllowed(string, time.Time) bool
}

type discoveryInvoice struct {
	Invoice, PaymentHash, Recipient, ProviderPubkey string
	ZapRequest                                      *nostr.Event
}

var errDiscoveryUnchanged = errors.New("discovery reward already changed")
var errDiscoveryUnavailable = errors.New("author cannot receive a public zap")

// DiscoveryRewards serializes local sends, while durable compare-and-set claims
// remain the authority across retries. A restarted sending record is lookup-only.
type DiscoveryRewards struct {
	store   discoveryRewardStore
	wallet  DiscoveryWallet
	prepare func(context.Context, *Discovery) (discoveryInvoice, error)
	now     func() time.Time
	mu      sync.Mutex
}

func NewDiscoveryRewards(store discoveryRewardStore, support *AuthorSupport, wallet DiscoveryWallet, pubkey, secret string, relays []string) *DiscoveryRewards {
	r := &DiscoveryRewards{store: store, wallet: wallet, now: time.Now}
	r.prepare = func(ctx context.Context, discovery *Discovery) (discoveryInvoice, error) {
		return support.prepareDiscoveryZap(ctx, discovery, pubkey, secret, relays)
	}
	return r
}

func (r *DiscoveryRewards) Start(ctx context.Context) {
	go func() {
		r.Process(ctx)
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				r.Process(ctx)
			}
		}
	}()
}

func (r *DiscoveryRewards) Process(ctx context.Context) {
	if r.wallet == nil || !r.mu.TryLock() {
		return
	}
	defer r.mu.Unlock()
	for _, discovery := range r.store.DiscoveriesForRewards() {
		if ctx.Err() != nil {
			return
		}
		now := r.now()
		if discovery.Reward.RetryAfter.After(now) {
			continue
		}
		switch discovery.Reward.Status {
		case "sending", "uncertain":
			// Recovery is allowed while paused, disabled, expired or removed.
			r.reconcile(ctx, discovery)
		case "pending", "preparing":
			if !discovery.ExpiresAt.After(now) {
				r.update(discovery.NoteID, func(reward *DiscoveryReward) error {
					if reward.Status != "pending" && reward.Status != "preparing" {
						return errDiscoveryUnchanged
					}
					reward.Status, reward.LastError = "failed", "discovery_expired_before_send"
					return nil
				})
				continue
			}
			if r.store.DiscoverySpendingAllowed(discovery.NoteID, now) {
				r.send(ctx, discovery)
			}
		}
	}
}

func (r *DiscoveryRewards) update(id string, mutate func(*DiscoveryReward) error) bool {
	err := r.store.UpdateDiscoveryReward(id, mutate)
	if err != nil && !errors.Is(err, errDiscoveryUnchanged) {
		// Never include wallet/provider errors, invoices or credentials in logs.
		log.Printf("Could not persist discovery reward transition for %s", short(id, 8))
	}
	return err == nil
}

func (r *DiscoveryRewards) deferPreparation(d *Discovery, code string) {
	r.update(d.NoteID, func(reward *DiscoveryReward) error {
		if reward.Status != "preparing" {
			return errDiscoveryUnchanged
		}
		reward.Status = "pending"
		reward.LastError = code
		reward.RetryAfter = r.now().Add(10 * time.Minute)
		return nil
	})
}

func (r *DiscoveryRewards) send(ctx context.Context, d *Discovery) {
	if !d.ExpiresAt.After(r.now()) {
		r.update(d.NoteID, func(reward *DiscoveryReward) error {
			if reward.Status != "pending" && reward.Status != "preparing" {
				return errDiscoveryUnchanged
			}
			reward.Status, reward.LastError = "failed", "discovery_expired_before_send"
			return nil
		})
		return
	}
	if !r.update(d.NoteID, func(reward *DiscoveryReward) error {
		if reward.Status != "pending" && reward.Status != "preparing" {
			return errDiscoveryUnchanged
		}
		if reward.PaymentHash != "" || !reward.AttemptedAt.IsZero() {
			return fmt.Errorf("unexpected previous reward attempt")
		}
		reward.Status, reward.LastError = "preparing", ""
		return nil
	}) {
		return
	}
	if err := r.wallet.Ready(ctx); err != nil {
		r.deferPreparation(d, "wallet_not_ready")
		return
	}
	invoice, err := r.prepare(ctx, d)
	if errors.Is(err, errAuthorHasNoAddress) || errors.Is(err, errDiscoveryUnavailable) {
		r.update(d.NoteID, func(reward *DiscoveryReward) error {
			if reward.Status != "preparing" {
				return errDiscoveryUnchanged
			}
			reward.Status, reward.LastError = "unavailable", "author_zap_unavailable"
			return nil
		})
		return
	}
	if err != nil {
		r.deferPreparation(d, "author_invoice_unavailable")
		return
	}
	if ctx.Err() != nil || !r.store.DiscoverySpendingAllowed(d.NoteID, r.now()) {
		r.deferPreparation(d, "curator_paused")
		return
	}
	// Save the invoice and send claim together before invoking the wallet. If
	// the process stops immediately afterwards, lookup is the only next action.
	if !r.update(d.NoteID, func(reward *DiscoveryReward) error {
		if reward.Status != "preparing" || reward.PaymentHash != "" {
			return errDiscoveryUnchanged
		}
		reward.Invoice, reward.PaymentHash = invoice.Invoice, invoice.PaymentHash
		reward.Recipient, reward.ProviderPubkey = invoice.Recipient, invoice.ProviderPubkey
		reward.WalletID, reward.ZapRequest = r.wallet.Identity(), cloneNostrEvent(invoice.ZapRequest)
		reward.PreparedAt, reward.AttemptedAt = r.now(), r.now()
		reward.Status, reward.LastError = "sending", ""
		return nil
	}) {
		return
	}
	result, err := r.wallet.Pay(ctx, invoice.Invoice)
	current, ok := r.store.GetDiscovery(d.NoteID)
	if !ok || current.Reward.PaymentHash != invoice.PaymentHash {
		return
	}
	if err != nil {
		// Even an error can arrive after the wallet sent money. In particular,
		// NOT_FOUND during subsequent lookup never permits a second send.
		r.uncertain(current, "wallet_send_unresolved")
		return
	}
	r.recordWalletResult(current, result)
}

func (r *DiscoveryRewards) uncertain(d *Discovery, code string) {
	r.update(d.NoteID, func(reward *DiscoveryReward) error {
		if reward.PaymentHash != d.Reward.PaymentHash || reward.WalletID != d.Reward.WalletID ||
			(reward.Status != "sending" && reward.Status != "uncertain") {
			return errDiscoveryUnchanged
		}
		reward.Status, reward.LastError = "uncertain", code
		reward.LastCheckedAt, reward.RetryAfter = r.now(), r.now().Add(5*time.Minute)
		return nil
	})
}

func (r *DiscoveryRewards) reconcile(ctx context.Context, d *Discovery) {
	if d.Reward.WalletID != r.wallet.Identity() {
		r.uncertain(d, "original_wallet_required")
		return
	}
	result, err := r.wallet.Lookup(ctx, d.Reward.PaymentHash)
	if err != nil {
		r.uncertain(d, "wallet_lookup_unresolved")
		return
	}
	r.recordWalletResult(d, result)
}

func validDiscoveryPreimage(value, hash string) bool {
	proof, err := hex.DecodeString(value)
	if err != nil || len(proof) != 32 {
		return false
	}
	digest := sha256.Sum256(proof)
	return hex.EncodeToString(digest[:]) == hash
}

func (r *DiscoveryRewards) recordWalletResult(d *Discovery, result DiscoveryWalletResult) {
	if result.PaymentHash != d.Reward.PaymentHash || result.AmountMsat != d.Reward.AmountSats*1000 ||
		(result.FeesPaidMsat != nil && *result.FeesPaidMsat < 0) {
		r.uncertain(d, "wallet_result_mismatch")
		return
	}
	// NIP-47 lookup state is optional. A matching preimage obtained from the
	// original outgoing wallet record is sufficient even when state is omitted.
	paid := validDiscoveryPreimage(result.Preimage, d.Reward.PaymentHash)
	failed := result.State == "failed" && result.Preimage == ""
	if !paid && !failed {
		r.uncertain(d, "wallet_payment_pending")
		return
	}
	r.update(d.NoteID, func(reward *DiscoveryReward) error {
		if reward.PaymentHash != d.Reward.PaymentHash || reward.WalletID != r.wallet.Identity() ||
			(reward.Status != "sending" && reward.Status != "uncertain") {
			return errDiscoveryUnchanged
		}
		reward.LastCheckedAt, reward.RetryAfter = r.now(), time.Time{}
		if paid {
			reward.Status, reward.LastError, reward.SettledAt = "paid", "", r.now()
			reward.FeesPaidMsat = result.FeesPaidMsat
		} else {
			reward.Status, reward.LastError = "failed", "wallet_payment_failed"
		}
		return nil
	})
}
