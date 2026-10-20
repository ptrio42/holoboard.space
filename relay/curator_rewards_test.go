package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sync"
	"testing"
	"time"
)

type rewardTestStore struct {
	mu          sync.Mutex
	discovery   *Discovery
	active      bool
	failSending bool
}

func (s *rewardTestStore) GetDiscovery(id string) (*Discovery, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.discovery == nil || s.discovery.NoteID != id {
		return nil, false
	}
	d := *s.discovery
	return &d, true
}
func (s *rewardTestStore) DiscoveriesForRewards() []*Discovery {
	d, ok := s.GetDiscovery(s.discovery.NoteID)
	if !ok {
		return nil
	}
	return []*Discovery{d}
}
func (s *rewardTestStore) DiscoverySpendingAllowed(_ string, _ time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.active
}
func (s *rewardTestStore) UpdateDiscoveryReward(id string, update func(*DiscoveryReward) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.discovery.NoteID != id {
		return errors.New("unknown discovery")
	}
	copy := s.discovery.Reward
	if err := update(&copy); err != nil {
		return err
	}
	if s.failSending && copy.Status == "sending" {
		return errors.New("disk full")
	}
	s.discovery.Reward = copy
	return nil
}

type rewardTestWallet struct {
	id                 string
	pays, lookups      int
	result             DiscoveryWalletResult
	payError, getError error
	beforePay          func()
}

func (w *rewardTestWallet) Identity() string            { return w.id }
func (w *rewardTestWallet) Ready(context.Context) error { return nil }
func (w *rewardTestWallet) Pay(context.Context, string) (DiscoveryWalletResult, error) {
	w.pays++
	if w.beforePay != nil {
		w.beforePay()
	}
	return w.result, w.payError
}
func (w *rewardTestWallet) Lookup(context.Context, string) (DiscoveryWalletResult, error) {
	w.lookups++
	return w.result, w.getError
}

func rewardExecutorFixture(t *testing.T) (*DiscoveryRewards, *rewardTestStore, *rewardTestWallet) {
	t.Helper()
	now := time.Now().UTC()
	proof := make([]byte, 32)
	proof[0] = 42
	hash := sha256.Sum256(proof)
	wallet := &rewardTestWallet{id: "independent-reward-wallet", result: DiscoveryWalletResult{
		State: "settled", PaymentHash: hex.EncodeToString(hash[:]), AmountMsat: 21000,
		Preimage: hex.EncodeToString(proof),
	}}
	store := &rewardTestStore{active: true, discovery: &Discovery{
		NoteID: "test-discovery", CreatedAt: now, ExpiresAt: now.Add(7 * 24 * time.Hour),
		Reward: DiscoveryReward{Status: "pending", AmountSats: 21},
	}}
	executor := &DiscoveryRewards{store: store, wallet: wallet, now: func() time.Time { return now },
		prepare: func(context.Context, *Discovery) (discoveryInvoice, error) {
			return discoveryInvoice{Invoice: "verified-invoice", PaymentHash: wallet.result.PaymentHash, Recipient: "original-author", ProviderPubkey: "snapshot-provider"}, nil
		},
	}
	return executor, store, wallet
}

func TestDiscoveryRewardPersistsBeforeSendAndNeverAddsPromotion(t *testing.T) {
	r, store, wallet := rewardExecutorFixture(t)
	wallet.beforePay = func() {
		d, _ := store.GetDiscovery("test-discovery")
		if d.Reward.Status != "sending" || d.Reward.PaymentHash == "" || d.Reward.Invoice != "verified-invoice" ||
			d.Reward.WalletID != wallet.id || d.Reward.Recipient != "original-author" || d.Reward.AttemptedAt.IsZero() {
			t.Fatalf("wallet called before durable send claim: %+v", d.Reward)
		}
	}
	r.Process(context.Background())
	r.Process(context.Background())
	d, _ := store.GetDiscovery("test-discovery")
	if wallet.pays != 1 || d.Reward.Status != "paid" || d.Reward.SettledAt.IsZero() {
		t.Fatalf("reward did not settle once: pays=%d, %+v", wallet.pays, d.Reward)
	}
}

func TestDiscoveryRewardTimeoutRestartPauseAndLateSettlement(t *testing.T) {
	r, store, wallet := rewardExecutorFixture(t)
	wallet.payError = context.DeadlineExceeded
	r.Process(context.Background())
	d, _ := store.GetDiscovery("test-discovery")
	if d.Reward.Status != "uncertain" || wallet.pays != 1 {
		t.Fatal("lost send response was not protected")
	}
	store.active = false
	// Restart the executor after midnight, while the fund is paused.
	now := r.now().Add(25 * time.Hour)
	restarted := &DiscoveryRewards{store: store, wallet: wallet, now: func() time.Time { return now }, prepare: r.prepare}
	wallet.getError = errors.New("NOT_FOUND")
	restarted.Process(context.Background())
	d, _ = store.GetDiscovery("test-discovery")
	if d.Reward.Status != "uncertain" || wallet.pays != 1 || wallet.lookups != 1 {
		t.Fatal("unknown lookup permitted another send")
	}
	wallet.getError = nil
	now = now.Add(6 * time.Minute)
	restarted.Process(context.Background())
	d, _ = store.GetDiscovery("test-discovery")
	if d.Reward.Status != "paid" || wallet.pays != 1 || wallet.lookups != 2 {
		t.Fatal("paused recovery did not settle the original payment")
	}
}

func TestDiscoveryRewardNeverSendsIfClaimCannotBeSaved(t *testing.T) {
	r, store, wallet := rewardExecutorFixture(t)
	store.failSending = true
	r.Process(context.Background())
	if wallet.pays != 0 {
		t.Fatal("sent money after save failure")
	}
	store.failSending = false
	r.Process(context.Background())
	if wallet.pays != 1 {
		t.Fatal("unsent preparation could not recover")
	}
}

func TestDiscoveryRewardRequiresOriginalWallet(t *testing.T) {
	r, store, wallet := rewardExecutorFixture(t)
	wallet.payError = context.DeadlineExceeded
	r.Process(context.Background())
	newWallet := &rewardTestWallet{id: "different-wallet", result: wallet.result}
	now := r.now().Add(time.Hour)
	r.wallet, r.now = newWallet, func() time.Time { return now }
	r.Process(context.Background())
	d, _ := store.GetDiscovery("test-discovery")
	if newWallet.pays != 0 || newWallet.lookups != 0 || d.Reward.LastError != "original_wallet_required" {
		t.Fatal("new wallet resolved a different wallet's attempt")
	}
	// A newly supplied matching proof is not enough without the original wallet.
	now = now.Add(time.Hour)
	r.wallet = wallet
	r.Process(context.Background())
	d, _ = store.GetDiscovery("test-discovery")
	if d.Reward.Status != "paid" || wallet.pays != 1 {
		t.Fatal("original wallet recovery failed")
	}
}

func TestDiscoveryRewardRejectsMismatchedWalletProofs(t *testing.T) {
	for _, field := range []string{"amount", "hash", "preimage", "fee"} {
		t.Run(field, func(t *testing.T) {
			r, store, wallet := rewardExecutorFixture(t)
			originalPrepare := r.prepare
			invoice, _ := originalPrepare(context.Background(), store.discovery)
			r.prepare = func(context.Context, *Discovery) (discoveryInvoice, error) { return invoice, nil }
			switch field {
			case "amount":
				wallet.result.AmountMsat++
			case "hash":
				wallet.result.PaymentHash = "wrong-hash"
			case "preimage":
				wallet.result.Preimage = "not-a-proof"
			case "fee":
				negative := int64(-1)
				wallet.result.FeesPaidMsat = &negative
			}
			r.Process(context.Background())
			d, _ := store.GetDiscovery("test-discovery")
			if d.Reward.Status != "uncertain" || wallet.pays != 1 {
				t.Fatal("invalid result was treated as a settled payment")
			}
		})
	}
}

func TestDiscoveryRewardUnavailableAuthorStillKeepsDiscovery(t *testing.T) {
	r, store, wallet := rewardExecutorFixture(t)
	r.prepare = func(context.Context, *Discovery) (discoveryInvoice, error) {
		return discoveryInvoice{}, errAuthorHasNoAddress
	}
	r.Process(context.Background())
	d, ok := store.GetDiscovery("test-discovery")
	if !ok || d.Reward.Status != "unavailable" || wallet.pays != 0 {
		t.Fatal("missing Lightning removed discovery or sent a payment")
	}
}

func TestDiscoveryRewardPauseDuringPreparationPreventsSend(t *testing.T) {
	r, store, wallet := rewardExecutorFixture(t)
	prepare := r.prepare
	r.prepare = func(ctx context.Context, d *Discovery) (discoveryInvoice, error) {
		store.active = false
		return prepare(ctx, d)
	}
	r.Process(context.Background())
	if wallet.pays != 0 {
		t.Fatal("pause during preparation did not stop send")
	}
}

func TestDiscoveryRewardExpiredUnattemptedFailsWithoutSend(t *testing.T) {
	r, store, wallet := rewardExecutorFixture(t)
	store.discovery.ExpiresAt = r.now().Add(-time.Second)
	r.Process(context.Background())
	if wallet.pays != 0 || store.discovery.Reward.Status != "failed" {
		t.Fatal("expired discovery was sent or kept reserving funds")
	}
}

func TestDiscoveryRewardRecoveryAcceptsProofWithoutOptionalState(t *testing.T) {
	r, store, wallet := rewardExecutorFixture(t)
	wallet.payError = context.DeadlineExceeded
	r.Process(context.Background())
	wallet.result.State = ""
	now := r.now().Add(time.Hour)
	r.now = func() time.Time { return now }
	r.Process(context.Background())
	if store.discovery.Reward.Status != "paid" || wallet.pays != 1 || wallet.lookups != 1 {
		t.Fatal("valid proof from original wallet was blocked by omitted optional state")
	}
}
