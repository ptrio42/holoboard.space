package main

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// profileFetchTimeout bounds the boot-time profile lookup. Nothing here is
// worth delaying startup over, and delaying startup is exactly what it did:
// on the first Fly deploy this took 32 seconds against an 8 second budget,
// because ranging the pool's channel waits for the channel to close rather
// than for the context, and two of the four relays were hanging. Fly checked
// for a listening socket long before the relay reached its own Start.
const profileFetchTimeout = 5 * time.Second

// relayProfile is the part of a kind:0 this relay cares about.
type relayProfile struct {
	Name    string `json:"name"`
	About   string `json:"about"`
	Picture string `json:"picture"`
	Lud16   string `json:"lud16"`
}

// fetchRelayProfile reads the relay's own kind:0 from the public relays.
//
// The relay's identity already lives on nostr: an avatar, a display name, and
// the lightning address that makes zaps to it resolve at all. Restating any of
// that in configuration means two sources that drift. This reads the one that
// clients already see.
//
// Returns nil when the profile cannot be reached, which is not an error worth
// failing a boot over.
func fetchRelayProfile(ctx context.Context, relays []string, pubkey string) *relayProfile {
	if len(relays) == 0 {
		return nil
	}

	ctx, cancel := context.WithTimeout(ctx, profileFetchTimeout)
	defer cancel()

	pool := nostr.NewSimplePool(ctx)
	events := pool.SubManyEose(ctx, relays, []nostr.Filter{{
		Kinds:   []int{0},
		Authors: []string{pubkey},
		Limit:   1,
	}})

	// Select on the context rather than ranging the channel. SimplePool closes
	// it only once every relay has answered or given up, and a relay that hangs
	// is not a reason to hold up the whole boot.
	var newest *nostr.Event
collect:
	for {
		select {
		case <-ctx.Done():
			break collect
		case event, ok := <-events:
			if !ok {
				break collect
			}
			if event.Event == nil {
				continue
			}
			if newest == nil || event.CreatedAt > newest.CreatedAt {
				newest = event.Event
			}
		}
	}

	if newest == nil {
		return nil
	}

	var profile relayProfile
	if err := json.Unmarshal([]byte(newest.Content), &profile); err != nil {
		log.Printf("Relay profile found but could not be parsed: %v", err)
		return nil
	}
	return &profile
}

// findPaymentProfileRelay returns a relay that actually supplied a signed
// recipient profile with a Lightning address. A note's source is only a hint.
func findPaymentProfileRelay(ctx context.Context, pubkey string, sources []string) string {
	profile, source := findRecipientProfile(ctx, pubkey, sources)
	if !profileHasPaymentAddress(profile) {
		return ""
	}
	return source
}

// findRecipientProfile is shared by quote hints and author invoice discovery.
// Keep profiles without an address so absence is distinct from failed discovery.
func findRecipientProfile(ctx context.Context, pubkey string, sources []string) (*nostr.Event, string) {
	ctx, cancel := context.WithTimeout(ctx, profileFetchTimeout)
	defer cancel()
	var profile *nostr.Event
	var source string
	var writes []string
	var lookups sync.WaitGroup
	lookups.Add(2)
	go func() {
		defer lookups.Done()
		directCtx, stop := context.WithTimeout(ctx, 2*time.Second)
		defer stop()
		profile, source = queryRecipientProfile(directCtx, pubkey, sources)
	}()
	go func() {
		defer lookups.Done()
		discoveryCtx, stop := context.WithTimeout(ctx, time.Second)
		defer stop()
		writes = authorWriteRelays(discoveryCtx, pubkey, sources)
	}()
	lookups.Wait()
	if len(writes) == 0 {
		return profile, source
	}
	// A cached kind:0, including one with no address, does not supersede a
	// newer profile on the author's NIP-65 write relays.
	writeProfile, writeSource := queryRecipientProfile(ctx, pubkey, writes)
	if newerReplaceableEvent(writeProfile, profile) {
		return writeProfile, writeSource
	}
	if writeProfile == nil && profileHasNoPaymentAddress(profile) {
		for _, relay := range writes {
			if nostr.NormalizeURL(relay) == source {
				return profile, source
			}
		}
		// An old address-free cache cannot establish absence when none of the
		// advertised write relays supplied a profile within the time budget.
		return nil, ""
	}
	return profile, source
}

// NIP-01 resolves replaceable events by timestamp, then the lowest event ID.
func newerReplaceableEvent(candidate, current *nostr.Event) bool {
	return candidate != nil && (current == nil || candidate.CreatedAt > current.CreatedAt ||
		(candidate.CreatedAt == current.CreatedAt && candidate.ID < current.ID))
}

func queryPaymentProfileRelay(ctx context.Context, pubkey string, sources []string) string {
	profile, source := queryRecipientProfile(ctx, pubkey, sources)
	if !profileHasPaymentAddress(profile) {
		return ""
	}
	return source
}

func queryRecipientProfile(ctx context.Context, pubkey string, sources []string) (*nostr.Event, string) {
	if len(sources) == 0 || ctx.Err() != nil {
		return nil, ""
	}
	ctx, cancel := context.WithCancel(ctx)
	pool := nostr.NewSimplePool(ctx)
	defer func() {
		cancel()
		pool.Relays.Range(func(_ string, relay *nostr.Relay) bool { relay.Close(); return true })
	}()
	events := pool.SubManyEose(ctx, dedupe(sources), nostr.Filters{{Kinds: []int{0}, Authors: []string{pubkey}, Limit: 1}})
	var newest *nostr.Event
	var source string
collect:
	for {
		select {
		case <-ctx.Done():
			break collect
		case result, ok := <-events:
			if !ok {
				break collect
			}
			event := result.Event
			if !validRecipientProfile(event, pubkey) {
				continue
			}
			if newerReplaceableEvent(event, newest) {
				newest, source = event, result.Relay.URL
			}
		}
	}
	return newest, source
}

type recipientPaymentProfile struct {
	Lud16 string `json:"lud16"`
	Lud06 string `json:"lud06"`
}

func paymentProfileMetadata(profile *nostr.Event) *recipientPaymentProfile {
	var metadata *recipientPaymentProfile
	if profile == nil || json.Unmarshal([]byte(profile.Content), &metadata) != nil {
		return nil
	}
	return metadata
}

func profileHasPaymentAddress(profile *nostr.Event) bool {
	metadata := paymentProfileMetadata(profile)
	return metadata != nil && (metadata.Lud16 != "" || metadata.Lud06 != "")
}

func profileHasNoPaymentAddress(profile *nostr.Event) bool {
	metadata := paymentProfileMetadata(profile)
	return metadata != nil && metadata.Lud16 == "" && metadata.Lud06 == ""
}

func validRecipientProfile(profile *nostr.Event, pubkey string) bool {
	if profile == nil || profile.Kind != 0 || profile.PubKey != pubkey || profile.GetID() != profile.ID {
		return false
	}
	valid, err := profile.CheckSignature()
	return err == nil && valid
}
