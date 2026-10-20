package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"time"

	"fiatjaf.com/nostr"
)

// prepareDiscoveryZap uses only the selected event's author and their verified
// signed profile. Model-provided URLs, invoices and recipients are never used.
func (a *AuthorSupport) prepareDiscoveryZap(ctx context.Context, d *Discovery, pubkey, secret string, relays []string) (discoveryInvoice, error) {
	if d.Event == nil || d.NoteID != d.Event.ID.Hex() || !isPromotable(d.Event.Kind) {
		return discoveryInvoice{}, fmt.Errorf("invalid discovery event")
	}
	if valid, err := verifyNostrEvent(d.Event); err != nil || !valid {
		return discoveryInvoice{}, fmt.Errorf("invalid discovery signature")
	}
	amount := d.Reward.AmountSats
	if amount != 21 && amount != 100 && amount != 500 {
		return discoveryInvoice{}, fmt.Errorf("invalid discovery reward tier")
	}
	if d.Event.PubKey.Hex() == pubkey {
		return discoveryInvoice{}, errDiscoveryUnavailable
	}
	details, err := a.endpoint(ctx, d.Event.PubKey.Hex(), d.SourceRelays...)
	if err != nil {
		return discoveryInvoice{}, err
	}
	if !details.Available || !details.AllowsNostr || amount < details.MinSats || amount > details.MaxSats {
		return discoveryInvoice{}, errDiscoveryUnavailable
	}
	sources := safeRelayCandidates(relays)
	if len(sources) == 0 {
		return discoveryInvoice{}, fmt.Errorf("no configured zap receipt relays")
	}
	zap := &nostr.Event{
		Kind: 9734, CreatedAt: nostr.Now(), PubKey: nostr.MustPubKeyFromHex(pubkey),
		Content: "Holoboard discovery reward for a post selected for the waiting room.",
		Tags: nostr.Tags{
			{"p", d.Event.PubKey.Hex()}, {"e", d.NoteID},
			{"amount", fmt.Sprint(amount * 1000)}, append(nostr.Tag{"relays"}, sources...),
		},
	}
	if err := signEvent(zap, secret); err != nil {
		return discoveryInvoice{}, fmt.Errorf("could not sign discovery zap")
	}
	if zap.PubKey.Hex() != pubkey {
		return discoveryInvoice{}, fmt.Errorf("discovery signer does not match board identity")
	}
	description, err := json.Marshal(zap)
	if err != nil {
		return discoveryInvoice{}, err
	}
	callback, err := url.Parse(details.callback)
	if err != nil {
		return discoveryInvoice{}, fmt.Errorf("invalid author callback")
	}
	query := callback.Query()
	query.Set("amount", fmt.Sprint(amount*1000))
	query.Set("nostr", string(description))
	callback.RawQuery = query.Encode()
	var response struct {
		Invoice string `json:"pr"`
		Status  string `json:"status"`
	}
	if err := a.readJSON(ctx, callback.String(), &response); err != nil || response.Status == "ERROR" {
		return discoveryInvoice{}, fmt.Errorf("author zap invoice unavailable")
	}
	invoice, err := decodeSupportInvoice(response.Invoice)
	if err != nil || int64(*invoice.MilliSat) != amount*1000 || invoice.DescriptionHash == nil ||
		*invoice.DescriptionHash != sha256.Sum256(description) || !invoice.Timestamp.Add(invoice.Expiry()).After(time.Now().Add(15*time.Second)) {
		return discoveryInvoice{}, fmt.Errorf("author zap invoice validation failed")
	}
	return discoveryInvoice{
		Invoice: response.Invoice, PaymentHash: hex.EncodeToString(invoice.PaymentHash[:]),
		Recipient: d.Event.PubKey.Hex(), ProviderPubkey: details.NostrPubkey, ZapRequest: zap,
	}, nil
}
