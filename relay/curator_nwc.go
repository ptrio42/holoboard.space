package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"

	"github.com/btcsuite/btcd/chaincfg"
	"github.com/lightningnetwork/lnd/zpay32"
)

// NWCDiscoveryWallet adds outgoing operations without extending the receiving
// LightningBackend or giving any receiving connection spending permissions.
type NWCDiscoveryWallet struct {
	backend *NWCBackend
	mu      sync.Mutex
	ready   bool
	loaded  bool
}

func NewNWCDiscoveryWallet(uri string) (*NWCDiscoveryWallet, error) {
	backend, err := ParseNWCURI(uri)
	if err != nil {
		return nil, err
	}
	return &NWCDiscoveryWallet{backend: backend}, nil
}

func (w *NWCDiscoveryWallet) Identity() string {
	// Relay destinations are transports, not wallet authorization identities.
	// Equivalent URLs or another relay for the same keys must preserve recovery.
	value := w.backend.walletPubkey + ":" + w.backend.clientPubkey
	hash := sha256.Sum256([]byte(value))
	return hex.EncodeToString(hash[:])
}

func (w *NWCDiscoveryWallet) loadInfo(ctx context.Context) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.loaded {
		return nil
	}
	if err := w.backend.LoadInfo(ctx); err != nil {
		return err
	}
	w.loaded = true
	return nil
}

func (w *NWCDiscoveryWallet) Ready(ctx context.Context) error {
	if err := w.loadInfo(ctx); err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.ready {
		return nil
	}
	var info struct {
		Methods []string `json:"methods"`
		Network string   `json:"network"`
	}
	if err := w.backend.request(ctx, "get_info", map[string]any{}, &info); err != nil {
		return err
	}
	if info.Network != "mainnet" && info.Network != "bitcoin" {
		return fmt.Errorf("reward wallet must use Bitcoin mainnet")
	}
	for _, required := range []string{"pay_invoice", "lookup_invoice"} {
		found := false
		for _, method := range info.Methods {
			found = found || method == required
		}
		if !found {
			return fmt.Errorf("reward wallet lacks %s permission", required)
		}
	}
	w.ready = true
	return nil
}

func (w *NWCDiscoveryWallet) Pay(ctx context.Context, invoice string) (DiscoveryWalletResult, error) {
	if err := w.Ready(ctx); err != nil {
		return DiscoveryWalletResult{}, err
	}
	decoded, err := zpay32.Decode(invoice, &chaincfg.MainNetParams)
	if err != nil || decoded.PaymentHash == nil || decoded.MilliSat == nil {
		return DiscoveryWalletResult{}, fmt.Errorf("invalid reward invoice")
	}
	var result struct {
		Preimage string `json:"preimage"`
		FeesPaid *int64 `json:"fees_paid"`
	}
	if err := w.backend.request(ctx, "pay_invoice", map[string]any{"invoice": invoice}, &result); err != nil {
		var rejection *nwcError
		if errors.As(err, &rejection) {
			switch rejection.Code {
			case "RESTRICTED", "UNAUTHORIZED", "INSUFFICIENT_BALANCE", "QUOTA_EXCEEDED", "NOT_IMPLEMENTED", "UNSUPPORTED_ENCRYPTION", "RATE_LIMITED":
				// These are explicit refusals to execute the request, not lost
				// responses. Release the reservation without retrying the send.
				return DiscoveryWalletResult{State: "failed", PaymentHash: hex.EncodeToString(decoded.PaymentHash[:]), AmountMsat: int64(*decoded.MilliSat)}, nil
			}
		}
		return DiscoveryWalletResult{}, err
	}
	return DiscoveryWalletResult{
		State: "settled", PaymentHash: hex.EncodeToString(decoded.PaymentHash[:]),
		AmountMsat: int64(*decoded.MilliSat), Preimage: result.Preimage, FeesPaidMsat: result.FeesPaid,
	}, nil
}

func (w *NWCDiscoveryWallet) Lookup(ctx context.Context, hash string) (DiscoveryWalletResult, error) {
	if !isHex64(hash) {
		return DiscoveryWalletResult{}, fmt.Errorf("invalid reward payment hash")
	}
	// Lookup must negotiate encryption after restart even when the fund is
	// disabled and the connection no longer permits sending new payments.
	if err := w.loadInfo(ctx); err != nil {
		return DiscoveryWalletResult{}, err
	}
	var tx struct {
		Type        string `json:"type"`
		State       string `json:"state"`
		PaymentHash string `json:"payment_hash"`
		Amount      int64  `json:"amount"`
		Preimage    string `json:"preimage"`
		FeesPaid    *int64 `json:"fees_paid"`
	}
	if err := w.backend.request(ctx, "lookup_invoice", map[string]any{"payment_hash": hash}, &tx); err != nil {
		return DiscoveryWalletResult{}, err
	}
	if tx.Type != "outgoing" || tx.PaymentHash != hash {
		return DiscoveryWalletResult{}, fmt.Errorf("reward lookup did not match the outgoing payment")
	}
	return DiscoveryWalletResult{
		State: tx.State, PaymentHash: tx.PaymentHash, AmountMsat: tx.Amount,
		Preimage: tx.Preimage, FeesPaidMsat: tx.FeesPaid,
	}, nil
}
