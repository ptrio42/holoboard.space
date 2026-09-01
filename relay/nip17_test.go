package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip44"
)

// A round trip through the envelope, and then the attacks it has to survive.
// The point of all of this is that a gift wrap's own author is a throwaway key
// and proves nothing; only the seal inside establishes who sent the message.

func TestGiftWrapRoundTrip(t *testing.T) {
	senderSK := nostr.GeneratePrivateKey()
	senderPK, _ := nostr.GetPublicKey(senderSK)
	recipientSK := nostr.GeneratePrivateKey()
	recipientPK, _ := nostr.GetPublicKey(recipientSK)

	wrap, err := wrapMessage("REMOVE note1abc", recipientPK, senderSK)
	if err != nil {
		t.Fatalf("failed to wrap: %v", err)
	}
	if wrap.Kind != kindGiftWrap {
		t.Errorf("kind = %d, want %d", wrap.Kind, kindGiftWrap)
	}
	if wrap.PubKey == senderPK {
		t.Error("the wrap is signed by the sender's own key, which leaks who sent it")
	}
	if p := wrap.Tags.GetFirst([]string{"p"}); p == nil || p.Value() != recipientPK {
		t.Error("the wrap is not addressed to the recipient")
	}

	rumor, err := unwrapGiftWrap(wrap, recipientSK)
	if err != nil {
		t.Fatalf("failed to unwrap: %v", err)
	}
	if rumor.Content != "REMOVE note1abc" {
		t.Errorf("content = %q, want the message that went in", rumor.Content)
	}
	if rumor.PubKey != senderPK {
		t.Errorf("sender = %s, want %s", short(rumor.PubKey, 8), short(senderPK, 8))
	}
	if rumor.Kind != kindChatMessage {
		t.Errorf("kind = %d, want %d", rumor.Kind, kindChatMessage)
	}
	// NIP-59 keeps the rumor unsigned so a leaked message proves nothing.
	if rumor.Sig != "" {
		t.Error("the message inside is signed, which it must not be")
	}
}

func TestSomebodyElseCannotReadIt(t *testing.T) {
	senderSK := nostr.GeneratePrivateKey()
	recipientPK, _ := nostr.GetPublicKey(nostr.GeneratePrivateKey())

	wrap, err := wrapMessage("secret", recipientPK, senderSK)
	if err != nil {
		t.Fatalf("failed to wrap: %v", err)
	}

	if _, err := unwrapGiftWrap(wrap, nostr.GeneratePrivateKey()); err == nil {
		t.Error("a message addressed to somebody else was opened")
	}
}

// The attack the seal check exists to stop: a valid wrap whose inner message
// claims to come from the operator.
func TestForgedSenderIsRejected(t *testing.T) {
	victimPK, _ := nostr.GetPublicKey(nostr.GeneratePrivateKey()) // the operator
	attackerSK := nostr.GeneratePrivateKey()
	attackerPK, _ := nostr.GetPublicKey(attackerSK)
	recipientSK := nostr.GeneratePrivateKey()
	recipientPK, _ := nostr.GetPublicKey(recipientSK)

	// A rumor that lies about who wrote it.
	rumor := nostr.Event{
		PubKey:    victimPK,
		CreatedAt: nostr.Now(),
		Kind:      kindChatMessage,
		Tags:      nostr.Tags{nostr.Tag{"p", recipientPK}},
		Content:   "REMOVE everything",
	}
	rumor.ID = rumor.GetID()

	// Sealed and wrapped correctly, by the attacker, who signs honestly.
	sealKey, _ := nip44.GenerateConversationKey(recipientPK, attackerSK)
	sealedContent, err := nip44Encrypt(mustJSON(rumor), sealKey)
	if err != nil {
		t.Fatalf("failed to encrypt: %v", err)
	}
	seal := nostr.Event{
		PubKey: attackerPK, CreatedAt: nostr.Now(), Kind: kindSeal,
		Tags: nostr.Tags{}, Content: sealedContent,
	}
	if err := seal.Sign(attackerSK); err != nil {
		t.Fatalf("failed to sign the seal: %v", err)
	}

	ephemeral := nostr.GeneratePrivateKey()
	wrapKey, _ := nip44.GenerateConversationKey(recipientPK, ephemeral)
	wrappedContent, err := nip44Encrypt(mustJSON(seal), wrapKey)
	if err != nil {
		t.Fatalf("failed to encrypt: %v", err)
	}
	wrap := &nostr.Event{
		CreatedAt: nostr.Now(), Kind: kindGiftWrap,
		Tags: nostr.Tags{nostr.Tag{"p", recipientPK}}, Content: wrappedContent,
	}
	if err := wrap.Sign(ephemeral); err != nil {
		t.Fatalf("failed to sign the wrap: %v", err)
	}

	rejected, err := unwrapGiftWrap(wrap, recipientSK)
	if err == nil {
		t.Fatalf("a forged sender was accepted as %s", short(rejected.PubKey, 8))
	}
	if !strings.Contains(err.Error(), "different author") {
		t.Errorf("rejected for the wrong reason: %v", err)
	}
}

// An unsigned seal must not be believed either.
func TestUnsignedSealIsRejected(t *testing.T) {
	attackerSK := nostr.GeneratePrivateKey()
	victimPK, _ := nostr.GetPublicKey(nostr.GeneratePrivateKey())
	recipientSK := nostr.GeneratePrivateKey()
	recipientPK, _ := nostr.GetPublicKey(recipientSK)

	rumor := nostr.Event{
		PubKey: victimPK, CreatedAt: nostr.Now(), Kind: kindChatMessage,
		Tags: nostr.Tags{}, Content: "REMOVE everything",
	}
	rumor.ID = rumor.GetID()

	// The seal claims the victim wrote it and carries no valid signature.
	sealKey, _ := nip44.GenerateConversationKey(recipientPK, attackerSK)
	sealedContent, _ := nip44Encrypt(mustJSON(rumor), sealKey)
	seal := nostr.Event{
		PubKey: victimPK, CreatedAt: nostr.Now(), Kind: kindSeal,
		Tags: nostr.Tags{}, Content: sealedContent, Sig: strings.Repeat("00", 64),
	}

	ephemeral := nostr.GeneratePrivateKey()
	wrapKey, _ := nip44.GenerateConversationKey(recipientPK, ephemeral)
	wrappedContent, _ := nip44Encrypt(mustJSON(seal), wrapKey)
	wrap := &nostr.Event{
		CreatedAt: nostr.Now(), Kind: kindGiftWrap,
		Tags: nostr.Tags{nostr.Tag{"p", recipientPK}}, Content: wrappedContent,
	}
	if err := wrap.Sign(ephemeral); err != nil {
		t.Fatalf("failed to sign the wrap: %v", err)
	}

	if _, err := unwrapGiftWrap(wrap, recipientSK); err == nil {
		t.Error("a seal with an invalid signature was accepted")
	}
}

func TestUnwrapRejectsTheWrongShapes(t *testing.T) {
	recipientSK := nostr.GeneratePrivateKey()

	if _, err := unwrapGiftWrap(nil, recipientSK); err == nil {
		t.Error("nil was accepted")
	}

	plain := &nostr.Event{Kind: 1, Content: "hello", Tags: nostr.Tags{}}
	if err := plain.Sign(nostr.GeneratePrivateKey()); err != nil {
		t.Fatalf("failed to sign: %v", err)
	}
	if _, err := unwrapGiftWrap(plain, recipientSK); err == nil {
		t.Error("a kind:1 was accepted as a gift wrap")
	}

	// Right kind, forged signature.
	fake := &nostr.Event{
		PubKey: strings.Repeat("ab", 32), CreatedAt: nostr.Now(), Kind: kindGiftWrap,
		Tags: nostr.Tags{}, Content: "nonsense", Sig: strings.Repeat("00", 64),
	}
	fake.ID = fake.GetID()
	if _, err := unwrapGiftWrap(fake, recipientSK); err == nil {
		t.Error("a gift wrap with an invalid signature was accepted")
	}
}

// The backdating is what hides when a message was sent, so it has to actually
// vary and never land in the future.
func TestGiftWrapTimestampIsDithered(t *testing.T) {
	senderSK := nostr.GeneratePrivateKey()
	recipientPK, _ := nostr.GetPublicKey(nostr.GeneratePrivateKey())

	seen := make(map[nostr.Timestamp]bool)
	now := nostr.Now()
	for i := 0; i < 20; i++ {
		wrap, err := wrapMessage("hello", recipientPK, senderSK)
		if err != nil {
			t.Fatalf("failed to wrap: %v", err)
		}
		if wrap.CreatedAt > now+60 {
			t.Errorf("timestamp %d is in the future", wrap.CreatedAt)
		}
		if int64(now-wrap.CreatedAt) > int64(giftWrapMaxBackdate.Seconds()) {
			t.Errorf("timestamp %d is further back than the window allows", wrap.CreatedAt)
		}
		seen[wrap.CreatedAt] = true
	}
	if len(seen) < 2 {
		t.Error("every gift wrap carried the same timestamp, so nothing is hidden")
	}
}

// A tampered ciphertext must fail rather than yield anything.
func TestTamperedContentIsRejected(t *testing.T) {
	senderSK := nostr.GeneratePrivateKey()
	recipientSK := nostr.GeneratePrivateKey()
	recipientPK, _ := nostr.GetPublicKey(recipientSK)

	wrap, err := wrapMessage("REMOVE note1abc", recipientPK, senderSK)
	if err != nil {
		t.Fatalf("failed to wrap: %v", err)
	}

	var tampered nostr.Event
	encoded, _ := json.Marshal(wrap)
	if err := json.Unmarshal(encoded, &tampered); err != nil {
		t.Fatalf("failed to copy: %v", err)
	}
	tampered.Content = "A" + tampered.Content[1:]
	if err := tampered.Sign(nostr.GeneratePrivateKey()); err != nil {
		t.Fatalf("failed to re-sign: %v", err)
	}

	if _, err := unwrapGiftWrap(&tampered, recipientSK); err == nil {
		t.Error("a tampered gift wrap was opened")
	}
}
