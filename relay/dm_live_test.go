package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

const productionRelayPubkey = "30bd172fc5295108b93de95516c811fabcfba0ec891e251645023329113d7643"

// TestProductionDMFlow exercises the deployed NIP-17 route with a disposable
// key and asks for one real, unpaid 1-sat invoice.
//
//	cd relay && HOLOBOARD_LIVE_DM=1 go test -run TestProductionDMFlow -v
func TestProductionDMFlow(t *testing.T) {
	if os.Getenv("HOLOBOARD_LIVE_DM") == "" {
		t.Skip("set HOLOBOARD_LIVE_DM=1 to create one unpaid 1-sat production invoice")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	noteID := liveBoardNoteID(t, ctx)
	senderPrivkey := nostr.GeneratePrivateKey()
	senderPubkey, err := nostr.GetPublicKey(senderPrivkey)
	if err != nil {
		t.Fatal(err)
	}
	testInboxes := []string{
		"wss://relay.primal.net",
		"wss://offchain.pub",
		"wss://auth.nostr1.com",
	}

	list := &nostr.Event{
		CreatedAt: nostr.Now(), Kind: kindDMRelayList, Tags: relayTags(testInboxes, "relay"),
	}
	if err := list.Sign(senderPrivkey); err != nil {
		t.Fatal(err)
	}
	metadataTargets := dedupe(append(append([]string{}, discoveryRelays...), testInboxes...))
	publishedLists := 0
	for _, relayURL := range metadataTargets {
		if err := publishSignedEvent(ctx, relayURL, list, senderPrivkey); err == nil {
			publishedLists++
		}
	}
	if publishedLists == 0 {
		t.Fatal("the disposable kind 10050 was not accepted by any discovery relay")
	}

	// Subscribe before publishing the command, so a fast response cannot land
	// in the gap between the write and the read subscription.
	receiver := NewDMMonitor(testInboxes, senderPubkey, senderPrivkey, nil, newTestStorage(t))
	since := nostr.Timestamp(time.Now().Add(-giftWrapMaxBackdate).Unix())
	replies := receiver.subscribe(ctx, nostr.Filters{{
		Kinds: []int{kindGiftWrap}, Tags: nostr.TagMap{"p": []string{senderPubkey}}, Since: &since,
	}})

	productionInboxes := recipientInbox(ctx, productionRelayPubkey, nil)
	if len(productionInboxes) == 0 {
		t.Fatal("production Holoboard has no discoverable kind 10050 inbox list")
	}
	command := fmt.Sprintf("PROMOTE 1 %s", noteReference(noteID))
	request, historyCopy, requestID, err := wrapMessageCopies(command, productionRelayPubkey, senderPrivkey, "")
	if err != nil {
		t.Fatal(err)
	}
	accepted := 0
	for _, relayURL := range productionInboxes {
		if err := publishSignedEvent(ctx, relayURL, request, senderPrivkey); err == nil {
			accepted++
		}
	}
	if accepted == 0 {
		t.Fatalf("production inbox relays all rejected the request: %v", productionInboxes)
	}
	for _, relayURL := range testInboxes {
		_ = publishSignedEvent(ctx, relayURL, historyCopy, senderPrivkey)
	}

	for {
		select {
		case <-ctx.Done():
			t.Fatalf("timed out waiting for the production reply: %v", ctx.Err())
		case wrap, ok := <-replies:
			if !ok {
				t.Fatal("all disposable inbox subscriptions stopped before a reply arrived")
			}
			message, err := unwrapGiftWrap(wrap, senderPrivkey)
			if err != nil || message.PubKey != productionRelayPubkey {
				continue
			}
			if firstTag(message, "e") != requestID {
				t.Fatalf("reply parent=%q, want request rumor %q", firstTag(message, "e"), requestID)
			}
			lower := strings.ToLower(message.Content)
			if !strings.Contains(lower, "1 sats") || !strings.Contains(lower, "lightning:lnbc") {
				t.Fatalf("production reply did not contain the expected 1-sat invoice: %s", message.Content)
			}
			t.Logf("production NIP-17 flow succeeded through %d/%d advertised inbox relays", accepted, len(productionInboxes))
			return
		}
	}
}

func liveBoardNoteID(t *testing.T, ctx context.Context) string {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://relay.holoboard.space/api/board", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("read production board: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("production board answered %s", response.Status)
	}
	var board struct {
		Entries []struct {
			ID string `json:"id"`
		} `json:"entries"`
	}
	if err := json.NewDecoder(response.Body).Decode(&board); err != nil {
		t.Fatalf("decode production board: %v", err)
	}
	if len(board.Entries) == 0 || !isHex64(board.Entries[0].ID) {
		t.Fatal("production board has no note suitable for the live DM check")
	}
	return board.Entries[0].ID
}
