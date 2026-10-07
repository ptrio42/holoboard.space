package nip42

import (
	"fiatjaf.com/nostr"
	"strings"
	"testing"
)

func TestHoloboardAuthenticationBindsSuppliedID(t *testing.T) {
	key := nostr.Generate()
	event := CreateUnsignedAuthEvent("challenge", key.Public(), "wss://relay.example")
	if err := event.Sign(key); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateAuthEvent(event, "challenge", "wss://relay.example"); err != nil {
		t.Fatal(err)
	}
	event.ID = nostr.MustIDFromHex(strings.Repeat("f", 64))
	if _, err := ValidateAuthEvent(event, "challenge", "wss://relay.example"); err == nil {
		t.Fatal("forged auth ID accepted")
	}
}
