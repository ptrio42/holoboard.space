package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestCuratorStatusSupportsPrivateReviewWithoutFinancialSecrets(t *testing.T) {
	c, now := curatorFixture(t, false)
	note := curatorNote(t, "A community workshop account", now.Add(-time.Hour), "")
	batch := seedCurator(t, c, note)
	rec := curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", curatorDecisionRequest{"private-review", batch, []CuratorDecision{curatorChoice(note, "community", 100)}})
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	// Even if a future proposal contains a financial journal, private model input
	// must remain limited to editorial review fields.
	c.storage.curator.Proposals[0].Reward.Invoice = "private-invoice-marker"
	c.storage.curator.Proposals[0].Reward.WalletID = "private-wallet-marker"
	c.storage.curator.Proposals[0].Reward.Recipient = "private-recipient-marker"
	rec = curatorRequest(t, c.StatusHandler(), "GET", "/", "curator-test", nil)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	var response struct {
		RecentProposals []struct {
			NoteID     string          `json:"note_id"`
			Event      json.RawMessage `json:"event"`
			RewardSats int64           `json:"reward_sats"`
		} `json:"recent_proposals"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil || len(response.RecentProposals) != 1 || response.RecentProposals[0].NoteID != note.ID.Hex() || response.RecentProposals[0].RewardSats != 100 || !strings.Contains(string(response.RecentProposals[0].Event), note.Content) {
		t.Fatal("status omitted the original needed for dry-run review")
	}
	for _, forbidden := range []string{"private-invoice-marker", "private-wallet-marker", "private-recipient-marker", "\"invoice\"", "\"wallet_id\""} {
		if strings.Contains(rec.Body.String(), forbidden) {
			t.Fatalf("status exposed %s", forbidden)
		}
	}
}

func TestDiscoveryCanBePromotedAndSupportedWithoutRefetchingItsRelay(t *testing.T) {
	c, now := curatorFixture(t, true)
	note := curatorNote(t, "An overlooked original, still available locally", now.Add(-time.Hour), "")
	batch := seedCurator(t, c, note)
	result := curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", curatorDecisionRequest{"promote-discovery", batch, []CuratorDecision{curatorChoice(note, "community", 100)}})
	if result.Code != 200 {
		t.Fatal(result.Body.String())
	}
	// There are deliberately no configured relays. The original is durable.
	fetcher := NewPostFetcher(nil)
	preview := postPromote(t, PreviewHandler(c.storage, fetcher), map[string]any{"note": note.ID.Hex()}, "1.2.3.4")
	if preview.Code != 200 {
		t.Fatal(preview.Body.String())
	}
	var data struct {
		Active bool  `json:"active"`
		Sats   int64 `json:"sats_paid"`
	}
	if err := json.Unmarshal(preview.Body.Bytes(), &data); err != nil || data.Active || data.Sats != 0 {
		t.Fatal("discovery was incorrectly previewed as a paid campaign")
	}
	support := NewAuthorSupport(c.storage, fetcher)
	stored, err := support.note(context.Background(), note.ID.Hex())
	if err != nil || stored.ID != note.ID {
		t.Fatal("author support could not find the discovery")
	}
	manager := NewInvoiceManager(NewMockLightningBackend(), c.storage, nil, 1000)
	promotion := postPromote(t, PromoteHandler(c.storage, manager, fetcher), promoteRequest{Note: note.ID.Hex(), AmountSats: 21}, "1.2.3.4")
	if promotion.Code != 200 {
		t.Fatal(promotion.Body.String())
	}
	var invoice promoteResponse
	if err := json.Unmarshal(promotion.Body.Bytes(), &invoice); err != nil {
		t.Fatal(err)
	}
	pending, ok := c.storage.GetPendingInvoice(invoice.PaymentHash)
	if !ok || pending.Event == nil || pending.Event.ID != note.ID {
		t.Fatal("invoice did not preserve the discovered original")
	}
	if c.storage.HasPost(note.ID.Hex()) {
		t.Fatal("preparing an invoice added unpaid ranking weight")
	}
	if _, err := c.storage.RemovePost(note.ID.Hex()); err != nil {
		t.Fatal(err)
	}
	if rec := postPromote(t, PreviewHandler(c.storage, fetcher), map[string]any{"note": note.ID.Hex()}, "1.2.3.4"); rec.Code != 409 {
		t.Fatal("removed discovery remained promotable")
	}
}
