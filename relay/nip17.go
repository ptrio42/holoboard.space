package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"strings"
	"time"

	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip19"
	"github.com/nbd-wtf/go-nostr/nip44"
)

// Gift wrapped direct messages, NIP-17 over NIP-59.
//
// https://github.com/nostr-protocol/nips/blob/master/17.md
// https://github.com/nostr-protocol/nips/blob/master/59.md
//
// The relay listened only for kind:4, which is why sending it a PROMOTE from a
// current client did nothing at all: those clients stopped writing kind:4. The
// ready-made way to fix that is go-nostr's nip17 package, but it arrived in
// v0.52, that needs Go 1.24, and the in-tree khatru is pinned to go-nostr
// v0.34. So the envelope is assembled here instead. Every cryptographic
// operation is still the library's nip44; what is written out by hand is the
// shape of the envelope, not the cryptography inside it.
//
// The security of the whole thing rests on one point. A gift wrap is signed by
// a key generated for that single message, so its author proves nothing at all
// about who sent it. The sender is established only by the seal inside, which
// carries a real signature. Anything that skips that check will happily believe
// whoever asks it to.

const (
	kindGiftWrap    = 1059
	kindSeal        = 13
	kindChatMessage = 14
	// kindDMRelayList tells clients where to deliver a gift wrap, and
	// kindRelayList is the general NIP-65 list clients fall back to.
	kindDMRelayList = 10050
	kindRelayList   = 10002

	// NIP-59 asks for a gift wrap's timestamp to be dithered into the past, so
	// that when a message was sent cannot be read off the relay.
	giftWrapMaxBackdate = 2 * 24 * time.Hour
)

// unwrapGiftWrap opens a kind:1059 addressed to us and returns the message
// inside, with its sender established rather than claimed.
//
// The returned event is a rumor: unsigned by design, since a signed one would
// be a message the recipient could prove to somebody else. Its PubKey has been
// checked against the signature on the seal, so it is the real sender.
func unwrapGiftWrap(giftWrap *nostr.Event, recipientPrivkey string) (*nostr.Event, error) {
	if giftWrap == nil || giftWrap.Kind != kindGiftWrap {
		return nil, fmt.Errorf("not a gift wrap")
	}

	// The wrap's own signature says nothing about the sender, but a wrap that
	// does not verify is malformed and not worth decrypting.
	if ok, err := giftWrap.CheckSignature(); err != nil || !ok {
		return nil, fmt.Errorf("gift wrap signature does not verify")
	}

	wrapKey, err := nip44.GenerateConversationKey(giftWrap.PubKey, recipientPrivkey)
	if err != nil {
		return nil, fmt.Errorf("failed to derive the wrap key: %w", err)
	}

	sealJSON, err := nip44.Decrypt(giftWrap.Content, wrapKey)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt the gift wrap: %w", err)
	}

	var seal nostr.Event
	if err := json.Unmarshal([]byte(sealJSON), &seal); err != nil {
		return nil, fmt.Errorf("the gift wrap did not contain an event: %w", err)
	}
	if seal.Kind != kindSeal {
		return nil, fmt.Errorf("expected a seal, found kind %d", seal.Kind)
	}

	// This is the check the whole scheme rests on.
	if ok, err := seal.CheckSignature(); err != nil || !ok {
		return nil, fmt.Errorf("the seal is not signed by the pubkey it claims")
	}

	sealKey, err := nip44.GenerateConversationKey(seal.PubKey, recipientPrivkey)
	if err != nil {
		return nil, fmt.Errorf("failed to derive the seal key: %w", err)
	}

	rumorJSON, err := nip44.Decrypt(seal.Content, sealKey)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt the seal: %w", err)
	}

	var rumor nostr.Event
	if err := json.Unmarshal([]byte(rumorJSON), &rumor); err != nil {
		return nil, fmt.Errorf("the seal did not contain an event: %w", err)
	}

	// Without this, anybody able to sign a seal could put somebody else's
	// pubkey on the message inside it and be believed.
	if rumor.PubKey != seal.PubKey {
		return nil, fmt.Errorf("the message inside claims a different author than the seal")
	}

	return &rumor, nil
}

// wrapMessage builds a kind:1059 carrying a chat message to one recipient.
//
// Two encryptions with two different keys: the seal is readable only by the
// recipient and proves who wrote it, and the wrap around it is addressed from a
// key that exists for this one message, so nothing on the outside links the
// message to its sender.
func wrapMessage(content, recipientPubkey, senderPrivkey string) (*nostr.Event, error) {
	senderPubkey, err := nostr.GetPublicKey(senderPrivkey)
	if err != nil {
		return nil, fmt.Errorf("failed to derive the sender pubkey: %w", err)
	}

	// The rumor. Never signed: NIP-59 leaves it unsigned so that a leaked
	// message cannot be proven to have come from anyone.
	rumor := nostr.Event{
		PubKey:    senderPubkey,
		CreatedAt: nostr.Now(),
		Kind:      kindChatMessage,
		Tags:      nostr.Tags{nostr.Tag{"p", recipientPubkey}},
		Content:   content,
	}
	rumor.ID = rumor.GetID()

	sealKey, err := nip44.GenerateConversationKey(recipientPubkey, senderPrivkey)
	if err != nil {
		return nil, fmt.Errorf("failed to derive the seal key: %w", err)
	}
	sealedContent, err := nip44Encrypt(mustJSON(rumor), sealKey)
	if err != nil {
		return nil, fmt.Errorf("failed to encrypt the rumor: %w", err)
	}

	seal := nostr.Event{
		PubKey:    senderPubkey,
		CreatedAt: backdated(),
		Kind:      kindSeal,
		Tags:      nostr.Tags{},
		Content:   sealedContent,
	}
	if err := seal.Sign(senderPrivkey); err != nil {
		return nil, fmt.Errorf("failed to sign the seal: %w", err)
	}

	// A key for this message and nothing else.
	ephemeralPrivkey := nostr.GeneratePrivateKey()
	wrapKey, err := nip44.GenerateConversationKey(recipientPubkey, ephemeralPrivkey)
	if err != nil {
		return nil, fmt.Errorf("failed to derive the wrap key: %w", err)
	}
	wrappedContent, err := nip44Encrypt(mustJSON(seal), wrapKey)
	if err != nil {
		return nil, fmt.Errorf("failed to encrypt the seal: %w", err)
	}

	giftWrap := &nostr.Event{
		CreatedAt: backdated(),
		Kind:      kindGiftWrap,
		Tags:      nostr.Tags{nostr.Tag{"p", recipientPubkey}},
		Content:   wrappedContent,
	}
	if err := giftWrap.Sign(ephemeralPrivkey); err != nil {
		return nil, fmt.Errorf("failed to sign the gift wrap: %w", err)
	}

	return giftWrap, nil
}

// backdated returns a timestamp somewhere in the last two days, so the moment a
// message was sent cannot be read off a relay.
func backdated() nostr.Timestamp {
	limit := big.NewInt(int64(giftWrapMaxBackdate / time.Second))
	offset, err := rand.Int(rand.Reader, limit)
	if err != nil {
		// Losing the dithering is a privacy weakness, not a correctness one,
		// and refusing to send the message would be the worse failure.
		return nostr.Now()
	}
	return nostr.Timestamp(time.Now().Add(-time.Duration(offset.Int64()) * time.Second).Unix())
}

func mustJSON(event nostr.Event) string {
	encoded, err := json.Marshal(event)
	if err != nil {
		// nostr.Event is plain data, so this cannot fail in practice.
		return "{}"
	}
	return string(encoded)
}

// defaultDMRelays is the inbox this relay advertises and reads.
//
// Deliberately not the same set as FETCH_RELAYS. Two of those, nos.lol and
// nostr.mom, refuse NIP-42 with a server-side configuration error, so this
// relay cannot read its own messages there; advertising them as an inbox
// invites senders to deliver somewhere nothing will ever be collected. Every
// relay here has been checked: damus serves the filter unauthenticated, and
// auth.nostr1.com accepts our AUTH.
var defaultDMRelays = []string{
	"wss://relay.damus.io",
	"wss://relay.primal.net",
	"wss://offchain.pub",
	"wss://auth.nostr1.com",
}

// discoveryRelays are where clients go looking for somebody's metadata, as
// opposed to where that somebody reads. purplepag.es in particular is the one
// most clients consult first, and a kind:10050 that is not there might as well
// not exist: the client falls back to the general relay list and delivers the
// message somewhere nobody is listening.
var discoveryRelays = []string{
	"wss://purplepag.es",
	"wss://relay.nostr.net",
	"wss://relay.primal.net",
	"wss://relay.damus.io",
}

// publishRelayLists says where to reach this relay, in both the places a client
// might look.
//
// Getting this wrong is silent. A message goes out, the sender's client reports
// success, and it lands on a relay nobody is subscribed to; nothing anywhere
// reports a failure. That is exactly what happened here: the kind:10050 went
// only to the relays this one reads, none of which a client consults for
// metadata, so clients fell back to a kind:10002 published in February that
// advertised three relays the DM monitor has never subscribed to.
//
// Both lists therefore say the same thing, and that thing is the set the
// monitor actually watches.
func publishRelayLists(ctx context.Context, privkey string, dmRelays, generalRelays []string) {
	// Where to deliver a direct message. This is an inbox: NIP-17 has the
	// sender publish to the recipient's list, the opposite way round to NIP-65,
	// so every entry has to be somewhere this relay can actually read.
	dmList := &nostr.Event{
		CreatedAt: nostr.Now(),
		Kind:      kindDMRelayList,
		Tags:      relayTags(dmRelays, "relay"),
	}
	// NIP-65. Clients fall back to this when they find no kind:10050, so it
	// pointing somewhere else is worse than it being absent.
	generalList := &nostr.Event{
		CreatedAt: nostr.Now(),
		Kind:      kindRelayList,
		Tags:      relayTags(generalRelays, "r"),
	}

	targets := append(append(append([]string{}, dmRelays...), generalRelays...), discoveryRelays...)

	for _, event := range []*nostr.Event{dmList, generalList} {
		if err := event.Sign(privkey); err != nil {
			log.Printf("Failed to sign the kind:%d relay list: %v", event.Kind, err)
			continue
		}
		published := publishEverywhere(ctx, event, targets)
		if published == 0 {
			log.Printf("Could not publish kind:%d anywhere; messages may not find us", event.Kind)
			continue
		}
		log.Printf("Published kind:%d to %d relays", event.Kind, published)
	}
}

func relayTags(relays []string, tagName string) nostr.Tags {
	tags := nostr.Tags{}
	for _, url := range relays {
		tags = append(tags, nostr.Tag{tagName, url})
	}
	return tags
}

// publishEverywhere sends one event to each target, skipping duplicates, and
// reports how many accepted it.
func publishEverywhere(ctx context.Context, event *nostr.Event, targets []string) int {
	pool := nostr.NewSimplePool(ctx)

	seen := map[string]bool{}
	published := 0
	for _, url := range targets {
		if seen[url] {
			continue
		}
		seen[url] = true

		relay, err := pool.EnsureRelay(url)
		if err != nil {
			continue
		}
		if err := relay.Publish(ctx, *event); err == nil {
			published++
		}
	}
	return published
}

// normalizePubkey accepts an npub or a bare hex pubkey and returns hex.
func normalizePubkey(input string) (string, error) {
	trimmed := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(input), "nostr:"))

	if isHex64(trimmed) {
		return strings.ToLower(trimmed), nil
	}

	prefix, data, err := nip19.Decode(trimmed)
	if err != nil {
		return "", fmt.Errorf("not an npub or a 64 character hex pubkey")
	}
	if prefix != "npub" {
		return "", fmt.Errorf("expected an npub, got %s", prefix)
	}
	pubkey, ok := data.(string)
	if !ok || !isHex64(pubkey) {
		return "", fmt.Errorf("the npub did not decode to a pubkey")
	}
	return pubkey, nil
}
