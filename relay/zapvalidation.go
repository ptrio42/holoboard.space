package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/btcsuite/btcd/chaincfg"
	"github.com/lightningnetwork/lnd/zpay32"
	"github.com/nbd-wtf/go-nostr"
)

// A zap receipt is not evidence of anything on its own. Anyone can generate a
// keypair, sign a kind:9735, put any string in its bolt11 tag and claim to have
// paid. The only thing that makes a receipt mean something is that it was
// signed by the nostr key belonging to the LNURL server of the address the
// money would have gone to. That key is what this file goes and gets.
//
// Spec: NIP-57, https://github.com/nostr-protocol/nips/blob/master/57.md.
// Appendix F is the receipt validation; Appendix D is the nested zap request.

const (
	lnurlFetchTimeout  = 10 * time.Second
	lnurlRefreshPeriod = 6 * time.Hour
)

// LNURLResolver keeps track of which nostr keys are allowed to say that this
// relay was paid.
//
// It holds a set rather than one key because a relay can legitimately have more
// than one lightning address, and this one does: its nostr profile advertises a
// different wallet from the one the NWC connection points at. A receipt from
// either provider is real money.
type LNURLResolver struct {
	client *http.Client

	mu        sync.RWMutex
	addresses []string
	pubkeys   map[string]string // lightning address -> nostrPubkey
	resolved  bool
}

func NewLNURLResolver() *LNURLResolver {
	return &LNURLResolver{
		client:  &http.Client{Timeout: lnurlFetchTimeout},
		pubkeys: make(map[string]string),
	}
}

// lnurlPayResponse is the LUD-06 payRequest document, with the two fields
// NIP-57 Appendix C adds to it.
type lnurlPayResponse struct {
	Tag         string `json:"tag"`
	AllowsNostr bool   `json:"allowsNostr"`
	NostrPubkey string `json:"nostrPubkey"`
}

// resolveAddress turns name@domain into the LNURL server's nostr pubkey.
func (r *LNURLResolver) resolveAddress(ctx context.Context, address string) (string, error) {
	name, domain, found := strings.Cut(address, "@")
	if !found || name == "" || domain == "" {
		return "", fmt.Errorf("%q is not a lightning address", address)
	}

	// LUD-16.
	endpoint := fmt.Sprintf("https://%s/.well-known/lnurlp/%s", domain, name)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", fmt.Errorf("failed to build request for %s: %w", address, err)
	}
	req.Header.Set("Accept", "application/json")

	res, err := r.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to reach the LNURL server for %s: %w", address, err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("LNURL server for %s answered %d", address, res.StatusCode)
	}

	var payload lnurlPayResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return "", fmt.Errorf("failed to parse the LNURL document for %s: %w", address, err)
	}

	if !payload.AllowsNostr {
		return "", fmt.Errorf("the LNURL server for %s does not do zaps", address)
	}
	if !isHex64(payload.NostrPubkey) {
		return "", fmt.Errorf("the LNURL server for %s gave no usable nostrPubkey", address)
	}

	return strings.ToLower(payload.NostrPubkey), nil
}

// Refresh re-reads every configured address. Addresses that fail keep whatever
// key they resolved to last time, so a provider having a bad five minutes does
// not stop the relay believing in payments it already knew how to check.
func (r *LNURLResolver) Refresh(ctx context.Context) {
	r.mu.RLock()
	addresses := append([]string(nil), r.addresses...)
	r.mu.RUnlock()

	for _, address := range addresses {
		pubkey, err := r.resolveAddress(ctx, address)
		if err != nil {
			log.Printf("Zap validation: %v", err)
			continue
		}

		r.mu.Lock()
		previous, existed := r.pubkeys[address]
		r.pubkeys[address] = pubkey
		r.resolved = true
		r.mu.Unlock()

		switch {
		case !existed:
			log.Printf("Zap validation: %s signs receipts with %s", address, short(pubkey, 16))
		case previous != pubkey:
			log.Printf("Zap validation: %s changed its zapper key to %s", address, short(pubkey, 16))
		}
	}

	if !r.Ready() {
		log.Printf("Zap validation: no zapper key could be resolved, so every zap will be refused. " +
			"Set ZAP_LNURL_ADDRESSES to the relay's lightning address.")
	}
}

// Start takes the addresses this relay collects on, resolves them, and keeps
// them fresh afterwards. Providers do rotate their keys.
//
// Addresses arrive here rather than at construction because they are only known
// once the relay's own nostr profile and its Lightning backend have been read,
// and the payment monitor needs the resolver before either of those happen.
func (r *LNURLResolver) Start(ctx context.Context, addresses []string) {
	cleaned := make([]string, 0, len(addresses))
	seen := make(map[string]bool, len(addresses))
	for _, address := range addresses {
		address = strings.ToLower(strings.TrimSpace(address))
		if address == "" || seen[address] {
			continue
		}
		seen[address] = true
		cleaned = append(cleaned, address)
	}

	r.mu.Lock()
	r.addresses = cleaned
	r.mu.Unlock()

	log.Printf("Zap validation: collecting on %d address(es): %s",
		len(cleaned), strings.Join(cleaned, ", "))

	r.Refresh(ctx)

	go func() {
		ticker := time.NewTicker(lnurlRefreshPeriod)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				r.Refresh(ctx)
			}
		}
	}()
}

// Ready reports whether at least one zapper key is known. Until one is, no zap
// can be checked, and an unchecked zap is not a payment.
func (r *LNURLResolver) Ready() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.resolved && len(r.pubkeys) > 0
}

// Accepts reports whether a pubkey is one of the LNURL servers for this relay.
func (r *LNURLResolver) Accepts(pubkey string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, known := range r.pubkeys {
		if known == pubkey {
			return true
		}
	}
	return false
}

// ZapDetails is what a receipt establishes once it has actually been checked.
type ZapDetails struct {
	AmountSats  int64
	PaymentHash string
	// Request is the verified kind:9734, the part that says who asked for the
	// promotion and what they asked to promote.
	Request *nostr.Event
}

// ValidateZapReceipt performs the NIP-57 checks on a kind:9735 and returns what
// it proves. An error means the receipt buys nothing.
//
// Everything here is a MUST in Appendix D or F except the description hash,
// which the spec calls a SHOULD. It is a MUST here. Without it a genuinely paid
// 21 sat invoice can be paired with somebody else's zap request, and the whole
// board becomes promotable for the price of one zap.
func ValidateZapReceipt(receipt *nostr.Event, relayPubkey string, resolver *LNURLResolver) (*ZapDetails, error) {
	if receipt == nil {
		return nil, fmt.Errorf("no receipt")
	}
	if receipt.Kind != 9735 {
		return nil, fmt.Errorf("event is kind %d, not a zap receipt", receipt.Kind)
	}

	// Appendix F1: the receipt must be signed by the recipient's LNURL server.
	// This is the whole trust anchor, so refuse rather than guess when the set
	// of acceptable keys is not known yet.
	if !resolver.Ready() {
		return nil, fmt.Errorf("no zapper key known yet, refusing to credit the zap")
	}
	if !resolver.Accepts(receipt.PubKey) {
		return nil, fmt.Errorf("receipt signed by %s, which is not this relay's LNURL server",
			short(receipt.PubKey, 16))
	}

	if recipient := firstTag(receipt, "p"); recipient != relayPubkey {
		return nil, fmt.Errorf("receipt is addressed to %s, not to this relay", short(recipient, 16))
	}

	bolt11 := firstTag(receipt, "bolt11")
	if bolt11 == "" {
		return nil, fmt.Errorf("receipt has no bolt11 tag")
	}

	// Mainnet only, and by full bech32 decode rather than by reading digits out
	// of the string. The hand rolled parser this replaces accepted invented
	// strings: "lnbc1000m1pfreeranknowplease" read as 100 million sats.
	invoice, err := zpay32.Decode(bolt11, &chaincfg.MainNetParams)
	if err != nil {
		return nil, fmt.Errorf("bolt11 is not a valid mainnet invoice: %w", err)
	}
	if invoice.MilliSat == nil {
		return nil, fmt.Errorf("invoice carries no amount")
	}

	amountMsat := int64(uint64(*invoice.MilliSat))
	amountSats := amountMsat / 1000
	if amountSats <= 0 {
		return nil, fmt.Errorf("invoice is for %d msat, under one sat", amountMsat)
	}

	description := firstTag(receipt, "description")
	if description == "" {
		return nil, fmt.Errorf("receipt has no description tag")
	}

	// Appendix E: SHA256 of the description must be the invoice's description
	// hash. This is what ties this particular payment to this particular
	// request, and nothing else does.
	if invoice.DescriptionHash == nil {
		return nil, fmt.Errorf("invoice carries no description hash")
	}
	sum := sha256.Sum256([]byte(description))
	if sum != *invoice.DescriptionHash {
		return nil, fmt.Errorf("description does not match the invoice it claims to have paid")
	}

	var request nostr.Event
	if err := json.Unmarshal([]byte(description), &request); err != nil {
		return nil, fmt.Errorf("description is not a zap request: %w", err)
	}
	if request.Kind != 9734 {
		return nil, fmt.Errorf("description is kind %d, not a zap request", request.Kind)
	}

	// Appendix D1. go-nostr checks the signature against the id, but does not
	// check that the id matches the content, and this JSON came from a stranger.
	if request.GetID() != request.ID {
		return nil, fmt.Errorf("zap request id does not match its content")
	}
	if ok, err := request.CheckSignature(); err != nil || !ok {
		return nil, fmt.Errorf("zap request is not validly signed")
	}

	// Appendix D3 and D4, plus the thing the spec cannot know: the request has
	// to be asking to pay *this* relay.
	if count := countTags(&request, "p"); count != 1 {
		return nil, fmt.Errorf("zap request has %d p tags, want exactly 1", count)
	}
	if target := firstTag(&request, "p"); target != relayPubkey {
		return nil, fmt.Errorf("zap request pays %s, not this relay", short(target, 16))
	}
	if count := countTags(&request, "e"); count > 1 {
		return nil, fmt.Errorf("zap request has %d e tags, want at most 1", count)
	}

	// Appendix F2.
	if declared := firstTag(&request, "amount"); declared != "" {
		wanted, err := strconv.ParseInt(declared, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("zap request amount %q is not a number", declared)
		}
		if wanted != amountMsat {
			return nil, fmt.Errorf("zap request asked for %d msat but the invoice is for %d",
				wanted, amountMsat)
		}
	}

	// Appendix D8.
	if p := firstTag(&request, "P"); p != "" && p != receipt.PubKey {
		return nil, fmt.Errorf("zap request names a different receipt signer")
	}

	paymentHash := ""
	if invoice.PaymentHash != nil {
		paymentHash = hex.EncodeToString(invoice.PaymentHash[:])
	}

	return &ZapDetails{
		AmountSats:  amountSats,
		PaymentHash: paymentHash,
		Request:     &request,
	}, nil
}

// firstTag returns the value of the first tag with this name, or "".
func firstTag(event *nostr.Event, name string) string {
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == name {
			return tag[1]
		}
	}
	return ""
}

func countTags(event *nostr.Event, name string) int {
	count := 0
	for _, tag := range event.Tags {
		if len(tag) >= 1 && tag[0] == name {
			count++
		}
	}
	return count
}
