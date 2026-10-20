package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func discoveryCampaignResponse(t *testing.T, c *CuratorService, path string) map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	CampaignHandler(c.storage)(rec, httptest.NewRequest("GET", path, nil))
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	var result map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestCuratorMixedNewFeedHasNoFakeRankOrPrivateReward(t *testing.T) {
	c, now := curatorFixture(t, true)
	for i := 0; i < 22; i++ {
		seedPaidNote(t, c.storage, fmt.Sprintf("Paid %d", i), int64(1000-i), now.Add(-time.Hour))
	}
	note := curatorNote(t, "unranked discovery", now.Add(-45*24*time.Hour), "")
	batch := seedCurator(t, c, note)
	rec := curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", curatorDecisionRequest{"feed", batch, []CuratorDecision{curatorChoice(note, "arts", 100)}})
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	c.storage.curator.Discoveries[note.ID.Hex()].Reward.Invoice = "private-invoice"
	c.storage.curator.Discoveries[note.ID.Hex()].Reward.PaymentHash = "private-hash"
	c.storage.curator.Discoveries[note.ID.Hex()].Reward.WalletID = "private-wallet"
	legacy := discoveryCampaignResponse(t, c, "/?view=new")
	if legacy["total"].(float64) != 1 || legacy["active_posts"].(float64) != 22 {
		t.Fatal(legacy)
	}
	mixed := discoveryCampaignResponse(t, c, "/?view=new&include_discoveries=true")
	if mixed["total"].(float64) != 2 || mixed["waiting_posts"].(float64) != 2 || mixed["active_posts"].(float64) != 22 || mixed["total_sats"] != legacy["total_sats"] {
		t.Fatal(mixed)
	}
	var entry map[string]any
	for _, raw := range mixed["entries"].([]any) {
		candidate := raw.(map[string]any)
		if candidate["entry_type"] == "discovery" {
			entry = candidate
			break
		}
	}
	if entry["entry_type"] != "discovery" || entry["id"] != note.ID.Hex() {
		t.Fatal(entry)
	}
	for _, field := range []string{"rank", "weight", "sats_paid", "first_paid_at", "last_paid_at", "hot_sats", "author_share"} {
		if _, ok := entry[field]; ok {
			t.Fatalf("fake %s in discovery: %v", field, entry)
		}
	}
	data, _ := json.Marshal(mixed)
	for _, secret := range []string{"private-invoice", "private-hash", "private-wallet", "payment_hash", "invoice", "wallet_id", "provider_pubkey", "zap_request"} {
		if strings.Contains(string(data), secret) {
			t.Fatalf("private field %s leaked", secret)
		}
	}
	board := discoveryCampaignResponse(t, c, "/?view=board&include_discoveries=true")
	if board["waiting_posts"].(float64) != 2 || len(board["entries"].([]any)) != 21 {
		t.Fatal(board)
	}
	// Disabling the pilot preserves the seven-day public placement.
	curatorRequest(t, c.AdminHandler("admin-test"), "POST", "/", "admin-test", map[string]string{"mode": "disabled"})
	if got := len(c.storage.DiscoveryWaitingEntries(c.storage.CampaignEntries(*now), *now)); got != 2 {
		t.Fatal(got)
	}
	if got := len(c.storage.DiscoveryWaitingEntries(c.storage.CampaignEntries(now.Add(8*24*time.Hour)), now.Add(8*24*time.Hour))); got != 1 {
		t.Fatalf("expired discovery remained: %d", got)
	}
	c.storage.removed[note.ID.Hex()] = true
	if got := len(c.storage.DiscoveryWaitingEntries(c.storage.CampaignEntries(*now), *now)); got != 1 {
		t.Fatal("removed discovery visible")
	}
}

func TestCuratorPaymentConversionPreservesOriginalExposureAndTop21Exclusion(t *testing.T) {
	c, now := curatorFixture(t, true)
	for i := 0; i < 21; i++ {
		seedPaidNote(t, c.storage, fmt.Sprintf("Board %d", i), int64(1000-i), *now)
	}
	note := curatorNote(t, "later paid", now.Add(-time.Hour), "")
	discoveredAt := now.Add(-30 * time.Minute)
	c.storage.curator.Discoveries[note.ID.Hex()] = &Discovery{NoteID: note.ID.Hex(), Event: note, Reason: "Useful", Topic: "science", Language: "en", CreatedAt: discoveredAt, ExpiresAt: now.Add(7 * 24 * time.Hour), Reward: DiscoveryReward{Status: "paid", AmountSats: 100}}
	if err := c.storage.AddPayment(note.ID.Hex(), 1, note); err != nil {
		t.Fatal(err)
	}
	entries := c.storage.DiscoveryWaitingEntries(c.storage.CampaignEntries(*now), *now)
	if len(entries) != 1 || entries[0].EntryType != "promotion" || entries[0].firstVisibleAtMillis != discoveredAt.UnixMilli() || entries[0].Rank != 22 || entries[0].Discovery.RewardStatus != "paid" {
		t.Fatalf("conversion changed exposure: %+v", entries)
	}
	since := now.Add(-15 * time.Minute).UnixMilli()
	query := fmt.Sprintf("/?since=%d", since)
	legacy := httptest.NewRecorder()
	WaitingUpdatesHandler(c.storage)(legacy, httptest.NewRequest("GET", query, nil))
	optin := httptest.NewRecorder()
	WaitingUpdatesHandler(c.storage)(optin, httptest.NewRequest("GET", query+"&include_discoveries=true", nil))
	var old, discoveryAware struct {
		Count int `json:"count"`
	}
	_ = json.Unmarshal(legacy.Body.Bytes(), &old)
	_ = json.Unmarshal(optin.Body.Bytes(), &discoveryAware)
	if old.Count != 1 || discoveryAware.Count != 0 {
		t.Fatalf("conversion created newness: %s / %s", legacy.Body.String(), optin.Body.String())
	}
	if err := c.storage.AddPayment(note.ID.Hex(), 2000, note); err != nil {
		t.Fatal(err)
	}
	if got := c.storage.DiscoveryWaitingEntries(c.storage.CampaignEntries(*now), *now); len(got) != 1 || got[0].ID == note.ID.Hex() {
		t.Fatal("top-ranked discovery stayed in New")
	}
}

func TestCuratorWaitingUpdateCountsDiscoveryMillisecondsAndExpiry(t *testing.T) {
	c, now := curatorFixture(t, true)
	note := curatorNote(t, "new", *now, "")
	visible := time.Now().Add(-2 * time.Second).Truncate(time.Millisecond)
	c.storage.curator.Discoveries[note.ID.Hex()] = &Discovery{NoteID: note.ID.Hex(), Event: note, CreatedAt: visible, ExpiresAt: visible.Add(7 * 24 * time.Hour), Reward: DiscoveryReward{Status: "pending", AmountSats: 21}}
	for _, test := range []struct {
		suffix string
		since  int64
		want   int
	}{{"", visible.UnixMilli() - 1, 0}, {"&include_discoveries=true", visible.UnixMilli() - 1, 1}, {"&include_discoveries=true", visible.UnixMilli(), 0}} {
		rec := httptest.NewRecorder()
		WaitingUpdatesHandler(c.storage)(rec, httptest.NewRequest("GET", fmt.Sprintf("/?since=%d%s", test.since, test.suffix), nil))
		var response struct {
			Count int `json:"count"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if rec.Code != 200 || response.Count != test.want {
			t.Fatal(rec.Body.String())
		}
	}
}
