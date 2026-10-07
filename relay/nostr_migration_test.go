package main

import (
	"context"
	"encoding/json"
	"fiatjaf.com/nostr/nip44"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"fiatjaf.com/nostr"
)

// Public historical event also used by upstream's verification fixtures.
// Keeping its original JSON prevents a round trip generated only by the new codec.
const legacyNostrEvent = `{"client_extension":{"label":"original","value":7},"kind":1,"id":"dc90c95f09947507c1044e8f48bcf6350aa6bff1507dd4acfc755b9239b5c962","pubkey":"3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d","created_at":1644271588,"tags":[],"content":"now that https://blueskyweb.org/blog/2-7-2022-overview was announced we can stop working on nostr?","sig":"230e9d8f0ddaf7eb70b5f7741ccfa37e87a455c9a469282e3464e2052d3192cd63a167e196e381ef9d7e69e9ea43af2443b839974dc85d8aaab9efe1d9296524"}`

func TestLegacyLedgerEventInvoiceAndOutboxRemainCompatible(t *testing.T) {
	const id = "dc90c95f09947507c1044e8f48bcf6350aa6bff1507dd4acfc755b9239b5c962"
	const hash = "legacy-payment-hash"
	path := filepath.Join(t.TempDir(), "ledger.json")
	raw := `{"posts":{"` + id + `":{"post_id":"` + id + `","event":` + legacyNostrEvent + `,"total_sats_paid":21,"last_payment_timestamp":"2026-10-07T10:00:00Z","first_promoted_at":"0001-01-01T00:00:00Z"}},"pending_invoices":{"` + hash + `":{"post_id":"` + id + `","invoice":"legacy-invoice","payment_hash":"` + hash + `","amount_sats":42,"created_at":"2026-10-07T10:00:00Z","expires_at":"2026-10-07T11:00:00Z","event":` + legacyNostrEvent + `}},"account_publications":{"legacy-publication":{"type":"reply","note_id":"` + id + `","event":` + legacyNostrEvent + `,"targets":["wss://relay.example"]}}}`
	if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
	storage, err := NewStorage(path)
	if err != nil {
		t.Fatal(err)
	}
	post, ok := storage.GetPost(id)
	if !ok || post.TotalSatsPaid != 21 {
		t.Fatal("ledger key or payment changed")
	}
	if valid, _ := verifyNostrEvent(post.Event); !valid {
		t.Fatal("historical signature rejected")
	}
	if err := storage.save(); err != nil {
		t.Fatal(err)
	}
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var before, after map[string]any
	json.Unmarshal([]byte(raw), &before)
	json.Unmarshal(saved, &after)
	for _, field := range []string{"posts", "pending_invoices", "account_publications"} {
		if !reflect.DeepEqual(before[field], after[field]) {
			t.Fatalf("legacy %s shape changed", field)
		}
	}
	reloaded, err := NewStorage(path)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.pendingInvoices[hash].Invoice != "legacy-invoice" || reloaded.accountPublications["legacy-publication"].Event.ID.Hex() != id {
		t.Fatal("invoice or durable publication lost")
	}
	note, err := encodeNoteReference(id)
	if err != nil || normalizeEventID(note) != id {
		t.Fatal("note reference changed")
	}
	nevent, err := encodeEventReference(id, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, author := noteHints(nevent); author != "" {
		t.Fatal("missing author became a zero-key hint")
	}
}

func TestRelayDialDoesNotFollowRedirects(t *testing.T) {
	var reached atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached.Add(1); w.WriteHeader(500) }))
	defer target.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer origin.Close()
	url := "ws" + strings.TrimPrefix(origin.URL, "http")
	trustConfiguredRelays([]string{url})
	relay, err := connectRelay(context.Background(), url)
	if relay != nil {
		relay.Close()
	}
	if err == nil || reached.Load() != 0 {
		t.Fatal("relay redirect bypassed pinned destination")
	}
}

func TestTypedHexBoundariesRejectInvalidIdentifiers(t *testing.T) {
	for _, value := range []string{"short", strings.Repeat("z", 64)} {
		if _, err := nostr.IDFromHex(value); err == nil {
			t.Fatal("invalid ID accepted")
		}
		if _, err := nostr.PubKeyFromHexCheap(value); err == nil {
			t.Fatal("invalid public key accepted")
		}
	}
}

func TestGiftWrapRejectsExplicitZeroRumorSignature(t *testing.T) {
	sender, recipient := generatePrivateKey(), generatePrivateKey()
	senderPK, _ := publicKeyForSecret(sender)
	recipientPK, _ := publicKeyForSecret(recipient)
	rumor := nostr.Event{Kind: kindChatMessage, PubKey: nostr.MustPubKeyFromHex(senderPK), CreatedAt: nostr.Now(), Tags: nostr.Tags{{"p", recipientPK}}, Content: "unsigned"}
	rumor.ID = rumor.GetID()
	encoded := mustJSON(rumor)
	encoded = strings.TrimSuffix(encoded, "}") + ",\"sig\":\"" + strings.Repeat("0", 128) + "\"}"
	sealKey, err := conversationKey(recipientPK, sender)
	if err != nil {
		t.Fatal(err)
	}
	content, err := nip44.Encrypt(encoded, sealKey)
	if err != nil {
		t.Fatal(err)
	}
	seal := nostr.Event{Kind: kindSeal, Tags: nostr.Tags{}, CreatedAt: nostr.Now(), Content: content}
	if err := signEvent(&seal, sender); err != nil {
		t.Fatal(err)
	}
	ephemeral := generatePrivateKey()
	wrapKey, err := conversationKey(recipientPK, ephemeral)
	if err != nil {
		t.Fatal(err)
	}
	content, err = nip44.Encrypt(mustJSON(seal), wrapKey)
	if err != nil {
		t.Fatal(err)
	}
	wrap := nostr.Event{Kind: kindGiftWrap, Tags: nostr.Tags{{"p", recipientPK}}, CreatedAt: nostr.Now(), Content: content}
	if err := signEvent(&wrap, ephemeral); err != nil {
		t.Fatal(err)
	}
	if _, err := unwrapGiftWrap(&wrap, recipient); err == nil {
		t.Fatal("explicit zero signature admitted as unsigned rumor")
	}
}
