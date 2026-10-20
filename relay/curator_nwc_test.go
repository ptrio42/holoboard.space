package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sync/atomic"
	"testing"
	"time"

	"github.com/btcsuite/btcd/chaincfg"
)

func TestDiscoveryNWCOutgoingRoundTrip(t *testing.T) {
	for _, encryption := range []string{encNIP04, encNIP44} {
		t.Run(encryption, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			relayURL := startTestRelay(t)
			invoice := mintInvoice(t, 21000, "discovery", &chaincfg.MainNetParams)
			decoded, _ := decodeSupportInvoice(invoice)
			hash := hex.EncodeToString(decoded.PaymentHash[:])
			var sends atomic.Int64
			fake := newFakeWallet(t, relayURL, encryption, "", func(method string, params map[string]any) walletReply {
				switch method {
				case "get_info":
					return walletReply{result: map[string]any{"network": "mainnet", "methods": []string{"pay_invoice", "lookup_invoice"}}}
				case "pay_invoice":
					sends.Add(1)
					if params["invoice"] != invoice {
						t.Error("different invoice sent to reward wallet")
					}
					return walletReply{result: map[string]any{"preimage": "wallet-proof", "fees_paid": 123}}
				case "lookup_invoice":
					if params["payment_hash"] != hash {
						t.Error("different payment hash queried")
					}
					return walletReply{result: map[string]any{"type": "outgoing", "state": "settled", "payment_hash": hash, "amount": 21000, "preimage": "wallet-proof", "fees_paid": 123}}
				default:
					t.Errorf("unexpected outgoing method: %s", method)
					return walletReply{}
				}
			})
			fake.start(ctx)
			wallet, err := NewNWCDiscoveryWallet(fake.connectionURI(generatePrivateKey()))
			if err != nil {
				t.Fatal(err)
			}
			if err := wallet.Ready(ctx); err != nil {
				t.Fatal(err)
			}
			result, err := wallet.Pay(ctx, invoice)
			if err != nil || result.PaymentHash != hash || result.AmountMsat != 21000 || result.FeesPaidMsat == nil || *result.FeesPaidMsat != 123 {
				t.Fatalf("invalid pay result: %+v, %v", result, err)
			}
			result, err = wallet.Lookup(ctx, hash)
			if err != nil || result.State != "settled" || result.PaymentHash != hash || sends.Load() != 1 {
				t.Fatalf("invalid lookup: %+v, %v", result, err)
			}
		})
	}
}

func TestDiscoveryNWCRejectsIncomingLookupAndReceivingOnlyConnection(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	url := startTestRelay(t)
	hashBytes := sha256.Sum256([]byte("test hash"))
	hash := hex.EncodeToString(hashBytes[:])
	fake := newFakeWallet(t, url, encNIP44, "", func(method string, _ map[string]any) walletReply {
		if method == "get_info" {
			return walletReply{result: map[string]any{"network": "mainnet", "methods": []string{"make_invoice", "lookup_invoice"}}}
		}
		return walletReply{result: map[string]any{"type": "incoming", "state": "settled", "payment_hash": hash, "amount": 21000}}
	})
	fake.start(ctx)
	wallet, _ := NewNWCDiscoveryWallet(fake.connectionURI(generatePrivateKey()))
	if err := wallet.Ready(ctx); err == nil {
		t.Fatal("receiving-only wallet accepted for rewards")
	}
	if _, err := wallet.Lookup(ctx, hash); err == nil {
		t.Fatal("incoming invoice confirmed an outgoing reward")
	}
}

func TestDiscoveryNWCIdentityBindsKeysRatherThanTransport(t *testing.T) {
	key := generatePrivateKey()
	pubkey, _ := publicKeyForSecret(generatePrivateKey())
	first, _ := NewNWCDiscoveryWallet("nostr+walletconnect://" + pubkey + "?relay=wss%3A%2F%2Fwallet.example&secret=" + key)
	second, _ := NewNWCDiscoveryWallet("nostr+walletconnect://" + pubkey + "?relay=wss%3A%2F%2Fwallet.example%2F&secret=" + key)
	third, _ := NewNWCDiscoveryWallet("nostr+walletconnect://" + pubkey + "?relay=wss%3A%2F%2Fother.example&secret=" + key)
	if first.Identity() != second.Identity() || first.Identity() != third.Identity() {
		t.Fatal("relay-only changes broke the original wallet connection identity")
	}
}

func TestDiscoveryNWCExplicitRefusalIsTerminalButAmbiguousErrorIsNot(t *testing.T) {
	for _, code := range []string{"INSUFFICIENT_BALANCE", "QUOTA_EXCEEDED", "RESTRICTED", "INTERNAL", "PAYMENT_FAILED"} {
		t.Run(code, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			url := startTestRelay(t)
			fake := newFakeWallet(t, url, encNIP44, "", func(method string, _ map[string]any) walletReply {
				if method == "get_info" {
					return walletReply{result: map[string]any{"network": "mainnet", "methods": []string{"pay_invoice", "lookup_invoice"}}}
				}
				return walletReply{err: &nwcError{Code: code, Message: "wallet refusal"}}
			})
			fake.start(ctx)
			wallet, _ := NewNWCDiscoveryWallet(fake.connectionURI(generatePrivateKey()))
			invoice := mintInvoice(t, 21000, "discovery", &chaincfg.MainNetParams)
			result, err := wallet.Pay(ctx, invoice)
			if code == "INTERNAL" || code == "PAYMENT_FAILED" {
				if err == nil {
					t.Fatal("ambiguous failure was considered definitely unpaid")
				}
			} else if err != nil || result.State != "failed" || result.PaymentHash == "" || result.AmountMsat != 21000 {
				t.Fatalf("known refusal did not release reservation: %+v, %v", result, err)
			}
		})
	}
}
