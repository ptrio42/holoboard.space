package main

import (
	"context"
	"encoding/json"
	"log"
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
