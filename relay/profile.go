package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// profileFetchTimeout bounds the boot-time profile lookup. Nothing here is
// worth delaying startup over.
const profileFetchTimeout = 8 * time.Second

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

	var newest *nostr.Event
	for event := range events {
		if event.Event == nil {
			continue
		}
		if newest == nil || event.CreatedAt > newest.CreatedAt {
			newest = event.Event
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
