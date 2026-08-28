package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/ecdsa"
	"github.com/btcsuite/btcd/chaincfg"
	"github.com/btcsuite/btcd/chaincfg/chainhash"
	"github.com/lightningnetwork/lnd/lnwire"
	"github.com/lightningnetwork/lnd/zpay32"
	"github.com/nbd-wtf/go-nostr"
)

// These tests mint genuine BOLT11 invoices with zpay32 and sign genuine nostr
// events, so what passes here is what would pass on the wire. The old parser
// was a regex over the invoice string, which is why "lnbc1000m1pfreeranknow"
// read as a hundred million sats.

const testRelayPubkey = "30bd172fc5295108b93de95516c811fabcfba0ec891e251645023329113d7643"

// seedResolver builds a resolver that already knows some zapper keys, without
// going near the network. Same package, so the fields are reachable.
func seedResolver(pubkeys ...string) *LNURLResolver {
	r := NewLNURLResolver()
	for i, pubkey := range pubkeys {
		r.pubkeys[fmt.Sprintf("test%d@example.com", i)] = pubkey
	}
	r.resolved = len(pubkeys) > 0
	return r
}

// mintInvoice builds and signs a real mainnet invoice for the given amount,
// committed to the given description.
func mintInvoice(t *testing.T, msat int64, description string, net *chaincfg.Params) string {
	t.Helper()

	nodeKey, err := btcec.NewPrivateKey()
	if err != nil {
		t.Fatalf("failed to make a node key: %v", err)
	}

	var paymentHash [32]byte
	if _, err := rand.Read(paymentHash[:]); err != nil {
		t.Fatalf("failed to make a payment hash: %v", err)
	}

	invoice, err := zpay32.NewInvoice(net, paymentHash, time.Now(),
		zpay32.Amount(lnwire.MilliSatoshi(msat)),
		zpay32.DescriptionHash(sha256.Sum256([]byte(description))),
	)
	if err != nil {
		t.Fatalf("failed to build invoice: %v", err)
	}

	encoded, err := invoice.Encode(zpay32.MessageSigner{
		SignCompact: func(msg []byte) ([]byte, error) {
			// btcec's SignCompact does not fail, so there is nothing to report.
			return ecdsa.SignCompact(nodeKey, chainhash.HashB(msg), true), nil
		},
	})
	if err != nil {
		t.Fatalf("failed to encode invoice: %v", err)
	}
	return encoded
}

// zapRequestJSON builds a signed kind:9734 as the payer would.
func zapRequestJSON(t *testing.T, payerSeckey string, tags nostr.Tags, content string) string {
	t.Helper()

	request := nostr.Event{
		CreatedAt: nostr.Now(),
		Kind:      9734,
		Tags:      tags,
		Content:   content,
	}
	if err := request.Sign(payerSeckey); err != nil {
		t.Fatalf("failed to sign zap request: %v", err)
	}

	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("failed to marshal zap request: %v", err)
	}
	return string(encoded)
}

// mintZapReceipt assembles a receipt the way a real LNURL server would, then
// hands back the pieces so a test can break exactly one of them.
func mintZapReceipt(t *testing.T, zapperSeckey string, msat int64, requestTags nostr.Tags) *nostr.Event {
	t.Helper()

	payer := nostr.GeneratePrivateKey()
	description := zapRequestJSON(t, payer, requestTags, "")
	bolt11 := mintInvoice(t, msat, description, &chaincfg.MainNetParams)

	receipt := &nostr.Event{
		CreatedAt: nostr.Now(),
		Kind:      9735,
		Tags: nostr.Tags{
			{"p", testRelayPubkey},
			{"bolt11", bolt11},
			{"description", description},
		},
	}
	if err := receipt.Sign(zapperSeckey); err != nil {
		t.Fatalf("failed to sign receipt: %v", err)
	}
	return receipt
}

func relayPTag() nostr.Tags {
	return nostr.Tags{{"p", testRelayPubkey}}
}

func TestValidateZapReceiptAcceptsARealZap(t *testing.T) {
	zapperSeckey := nostr.GeneratePrivateKey()
	zapperPubkey, err := nostr.GetPublicKey(zapperSeckey)
	if err != nil {
		t.Fatalf("failed to derive zapper pubkey: %v", err)
	}

	receipt := mintZapReceipt(t, zapperSeckey, 21_000, relayPTag())

	details, err := ValidateZapReceipt(receipt, testRelayPubkey, seedResolver(zapperPubkey))
	if err != nil {
		t.Fatalf("a genuine zap was rejected: %v", err)
	}
	if details.AmountSats != 21 {
		t.Errorf("amount = %d sats, want 21", details.AmountSats)
	}
	if details.Request == nil || details.Request.Kind != 9734 {
		t.Error("the verified zap request did not come back")
	}
	if details.PaymentHash == "" {
		t.Error("payment hash missing")
	}
}

// TestValidateZapReceiptRefusesAForgedReceipt is the whole point of the file.
// Before this validation existed, this exact event bought a hundred million
// sats of rank for nothing.
func TestValidateZapReceiptRefusesAForgedReceipt(t *testing.T) {
	honest := nostr.GeneratePrivateKey()
	honestPubkey, err := nostr.GetPublicKey(honest)
	if err != nil {
		t.Fatalf("failed to derive pubkey: %v", err)
	}

	attacker := nostr.GeneratePrivateKey()
	receipt := &nostr.Event{
		CreatedAt: nostr.Now(),
		Kind:      9735,
		Tags: nostr.Tags{
			{"p", testRelayPubkey},
			{"bolt11", "lnbc1000m1pfreeranknowplease"},
			{"description", `{"kind":9734,"tags":[["e","dead"]],"content":""}`},
		},
	}
	if err := receipt.Sign(attacker); err != nil {
		t.Fatalf("failed to sign: %v", err)
	}

	if _, err := ValidateZapReceipt(receipt, testRelayPubkey, seedResolver(honestPubkey)); err == nil {
		t.Fatal("a forged receipt was accepted")
	}
}

func TestValidateZapReceiptRejections(t *testing.T) {
	zapperSeckey := nostr.GeneratePrivateKey()
	zapperPubkey, err := nostr.GetPublicKey(zapperSeckey)
	if err != nil {
		t.Fatalf("failed to derive zapper pubkey: %v", err)
	}
	resolver := seedResolver(zapperPubkey)

	cases := []struct {
		name    string
		build   func(t *testing.T) *nostr.Event
		wantHas string
	}{
		{
			name: "signed by a key that is not our LNURL server",
			build: func(t *testing.T) *nostr.Event {
				return mintZapReceipt(t, nostr.GeneratePrivateKey(), 21_000, relayPTag())
			},
			wantHas: "not this relay's LNURL server",
		},
		{
			name: "addressed to somebody else",
			build: func(t *testing.T) *nostr.Event {
				receipt := mintZapReceipt(t, zapperSeckey, 21_000, relayPTag())
				receipt.Tags[0] = nostr.Tag{"p", strings.Repeat("ab", 32)}
				return receipt
			},
			wantHas: "not to this relay",
		},
		{
			name: "invoice is on testnet",
			build: func(t *testing.T) *nostr.Event {
				payer := nostr.GeneratePrivateKey()
				description := zapRequestJSON(t, payer, relayPTag(), "")
				bolt11 := mintInvoice(t, 2_000_000_000, description, &chaincfg.TestNet3Params)
				receipt := &nostr.Event{
					CreatedAt: nostr.Now(), Kind: 9735,
					Tags: nostr.Tags{
						{"p", testRelayPubkey},
						{"bolt11", bolt11},
						{"description", description},
					},
				}
				if err := receipt.Sign(zapperSeckey); err != nil {
					t.Fatal(err)
				}
				return receipt
			},
			wantHas: "not a valid mainnet invoice",
		},
		{
			name: "description swapped for a different request",
			build: func(t *testing.T) *nostr.Event {
				receipt := mintZapReceipt(t, zapperSeckey, 21_000, relayPTag())
				// A genuinely paid invoice, re-labelled to promote something else.
				other := zapRequestJSON(t, nostr.GeneratePrivateKey(),
					nostr.Tags{{"p", testRelayPubkey}, {"e", strings.Repeat("cd", 32)}}, "")
				for i, tag := range receipt.Tags {
					if tag[0] == "description" {
						receipt.Tags[i] = nostr.Tag{"description", other}
					}
				}
				if err := receipt.Sign(zapperSeckey); err != nil {
					t.Fatal(err)
				}
				return receipt
			},
			wantHas: "does not match the invoice",
		},
		{
			name: "zap request pays a different relay",
			build: func(t *testing.T) *nostr.Event {
				return mintZapReceipt(t, zapperSeckey, 21_000,
					nostr.Tags{{"p", strings.Repeat("ef", 32)}})
			},
			wantHas: "not this relay",
		},
		{
			name: "zap request has no p tag",
			build: func(t *testing.T) *nostr.Event {
				return mintZapReceipt(t, zapperSeckey, 21_000, nostr.Tags{})
			},
			wantHas: "p tags",
		},
		{
			name: "declared amount disagrees with the invoice",
			build: func(t *testing.T) *nostr.Event {
				return mintZapReceipt(t, zapperSeckey, 21_000,
					nostr.Tags{{"p", testRelayPubkey}, {"amount", strconv.Itoa(9_000_000)}})
			},
			wantHas: "but the invoice is for",
		},
		{
			name: "receipt is not a zap receipt",
			build: func(t *testing.T) *nostr.Event {
				receipt := mintZapReceipt(t, zapperSeckey, 21_000, relayPTag())
				receipt.Kind = 1
				return receipt
			},
			wantHas: "not a zap receipt",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := ValidateZapReceipt(c.build(t), testRelayPubkey, resolver)
			if err == nil {
				t.Fatal("expected a rejection, got none")
			}
			if !strings.Contains(err.Error(), c.wantHas) {
				t.Errorf("rejected with %q, want it to mention %q", err, c.wantHas)
			}
		})
	}
}

// TestValidateZapReceiptFailsClosed: with no zapper key resolved there is no
// way to check anything, so nothing may be believed.
func TestValidateZapReceiptFailsClosed(t *testing.T) {
	zapperSeckey := nostr.GeneratePrivateKey()
	receipt := mintZapReceipt(t, zapperSeckey, 21_000, relayPTag())

	_, err := ValidateZapReceipt(receipt, testRelayPubkey, NewLNURLResolver())
	if err == nil {
		t.Fatal("a zap was credited with no zapper key known")
	}
	if !strings.Contains(err.Error(), "no zapper key known") {
		t.Errorf("rejected with %q", err)
	}
}

func TestLNURLResolver(t *testing.T) {
	const zapper = "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44"

	cases := []struct {
		name      string
		handler   http.HandlerFunc
		wantReady bool
	}{
		{
			name: "a wallet that does zaps",
			handler: func(w http.ResponseWriter, r *http.Request) {
				if !strings.HasPrefix(r.URL.Path, "/.well-known/lnurlp/") {
					w.WriteHeader(http.StatusNotFound)
					return
				}
				fmt.Fprintf(w, `{"tag":"payRequest","allowsNostr":true,"nostrPubkey":%q}`, zapper)
			},
			wantReady: true,
		},
		{
			name: "a wallet that does not do zaps",
			handler: func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprint(w, `{"tag":"payRequest","allowsNostr":false}`)
			},
			wantReady: false,
		},
		{
			name: "a wallet with a malformed key",
			handler: func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprint(w, `{"tag":"payRequest","allowsNostr":true,"nostrPubkey":"nope"}`)
			},
			wantReady: false,
		},
		{
			name: "a wallet that is down",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusBadGateway)
			},
			wantReady: false,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewTLSServer(c.handler)
			defer srv.Close()

			resolver := NewLNURLResolver()
			// Point the resolver at the test server, which speaks TLS with a
			// certificate nothing else trusts.
			resolver.client = srv.Client()
			resolver.addresses = []string{"holoboard@" + strings.TrimPrefix(srv.URL, "https://")}

			resolver.Refresh(context.Background())

			if got := resolver.Ready(); got != c.wantReady {
				t.Errorf("Ready() = %v, want %v", got, c.wantReady)
			}
			if c.wantReady && !resolver.Accepts(zapper) {
				t.Error("the resolved key was not accepted")
			}
			if resolver.Accepts(strings.Repeat("00", 32)) {
				t.Error("an unrelated key was accepted")
			}
		})
	}
}
