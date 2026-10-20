package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func setCuratorReview(t *testing.T, c *CuratorService, required bool) {
	t.Helper()
	rec := curatorRequest(t, c.ReviewHandler(), "POST", "/", "review-test", map[string]any{"action": "set_review", "review_required": required})
	if rec.Code != 200 {
		t.Fatalf("set review: %d %s", rec.Code, rec.Body.String())
	}
}

func pendingCuratorReview(t *testing.T, c *CuratorService, id string, action string) curatorReviewRequest {
	t.Helper()
	for _, item := range curatorReviewItems(c.storage.curator, c.now()) {
		if item.NoteID == id {
			request := curatorReviewRequest{Action: action, NoteID: id, ReviewID: curatorReviewID(item.Discovery)}
			if action == "approve" {
				request.RewardSats = item.Discovery.Reward.AmountSats
			}
			return request
		}
	}
	t.Fatal("pending review not found")
	return curatorReviewRequest{}
}

func TestCuratorReviewDefaultsOnAndUsesSeparateAuthority(t *testing.T) {
	config := DefaultCuratorConfig()
	if !config.ReviewRequired || !curatorReviewRequired(&curatorState{}) {
		t.Fatal("new or legacy state bypasses review by default")
	}
	c, _ := curatorFixture(t, false)
	for _, token := range []string{"", "curator-test", "admin-test"} {
		for _, method := range []string{"GET", "POST"} {
			if got := curatorRequest(t, c.ReviewHandler(), method, "/", token, map[string]any{"action": "set_review", "review_required": false}).Code; got != 401 {
				t.Fatalf("%s accepted reviewer authority from %q: %d", method, token, got)
			}
		}
	}
	if got := curatorRequest(t, c.AdminHandler("admin-test"), "POST", "/", "review-test", map[string]string{"mode": "active"}).Code; got != 401 {
		t.Fatal("reviewer can activate the fund")
	}
	if got := curatorRequest(t, c.ReviewHandler(), "DELETE", "/", "review-test", nil).Code; got != 405 {
		t.Fatal("unsupported review method accepted")
	}
	c.config.ReviewToken = ""
	if got := curatorRequest(t, c.ReviewHandler(), "GET", "/", "", nil).Code; got != 401 {
		t.Fatal("unconfigured reviewer was allowed")
	}
}

func TestCuratorReviewQueuesBeforePlacementAndApprovalReplaysAfterRestart(t *testing.T) {
	c, now := curatorFixture(t, true)
	setCuratorReview(t, c, true)
	note := curatorNote(t, "An original project awaiting review", *now, "")
	batch := seedCurator(t, c, note)
	rec := curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", curatorDecisionRequest{"review-round", batch, []CuratorDecision{curatorChoice(note, "projects", 100)}})
	if rec.Code != 200 || len(c.storage.curator.PendingReviews) != 1 || len(c.storage.curator.Discoveries) != 0 || len(c.storage.DiscoveriesForRewards()) != 0 {
		t.Fatalf("unreviewed post was admitted: %s", rec.Body.String())
	}
	request := pendingCuratorReview(t, c, note.ID.Hex(), "approve")
	*now = now.Add(24 * time.Hour)
	rec = curatorRequest(t, c.ReviewHandler(), "POST", "/", "review-test", request)
	d := c.storage.curator.Discoveries[note.ID.Hex()]
	if rec.Code != 200 || d == nil || d.ReviewStatus != "approved" || d.Reward.Status != "pending" ||
		!d.CreatedAt.Equal(*now) || !d.ExpiresAt.Equal(now.Add(curatorPlacement)) || len(c.storage.curator.PendingReviews) != 0 || !c.storage.DiscoverySpendingAllowed(note.ID.Hex(), *now) {
		t.Fatalf("approval did not create a reviewed seven-day placement: %s", rec.Body.String())
	}
	created := d.CreatedAt
	loaded, err := NewStorage(c.storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	restarted := NewCuratorService(loaded, nil, c.config)
	restarted.now = c.now
	if !curatorReviewRequired(restarted.storage.curator) {
		t.Fatal("restart reset review setting")
	}
	retry := curatorRequest(t, restarted.ReviewHandler(), "POST", "/", "review-test", request)
	if retry.Code != 200 || !loaded.curator.Discoveries[note.ID.Hex()].CreatedAt.Equal(created) || len(loaded.curator.Discoveries) != 1 {
		t.Fatalf("approval replay changed placement: %s", retry.Body.String())
	}
	request.Action, request.RewardSats = "reject", 0
	if got := curatorRequest(t, restarted.ReviewHandler(), "POST", "/", "review-test", request).Code; got != 409 {
		t.Fatal("review overwrote an approved decision")
	}
}

func TestCuratorReviewOffDoesNotReleaseWaitingQueueAndOnBlocksUnattemptedRewards(t *testing.T) {
	c, now := curatorFixture(t, true)
	setCuratorReview(t, c, true)
	queued := curatorNote(t, "Queued", *now, "")
	batch := seedCurator(t, c, queued)
	curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", curatorDecisionRequest{"queued", batch, []CuratorDecision{curatorChoice(queued, "arts", 21)}})
	setCuratorReview(t, c, false)
	if len(c.storage.curator.PendingReviews) != 1 || len(c.storage.DiscoveriesForRewards()) != 0 {
		t.Fatal("turning review off approved the waiting queue")
	}
	*now = now.Add(12 * time.Hour)
	auto := curatorNote(t, "Future automatic selection", *now, "")
	batch = seedCurator(t, c, auto)
	curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", curatorDecisionRequest{"automatic", batch, []CuratorDecision{curatorChoice(auto, "science", 100)}})
	id := auto.ID.Hex()
	if !c.storage.DiscoverySpendingAllowed(id, *now) {
		t.Fatal("review-off future selection cannot spend")
	}
	if err := c.storage.UpdateDiscoveryReward(id, func(reward *DiscoveryReward) error { reward.Status = "preparing"; return nil }); err != nil {
		t.Fatal(err)
	}
	setCuratorReview(t, c, true)
	if c.storage.DiscoverySpendingAllowed(id, *now) {
		t.Fatal("enabling review did not stop an unattempted automatic reward")
	}
	if err := c.storage.UpdateDiscoveryReward(id, func(reward *DiscoveryReward) error { reward.Status = "sending"; return nil }); err == nil {
		t.Fatal("a send claim bypassed review after preparation")
	}
	request := pendingCuratorReview(t, c, id, "approve")
	if rec := curatorRequest(t, c.ReviewHandler(), "POST", "/", "review-test", request); rec.Code != 200 || !c.storage.DiscoverySpendingAllowed(id, *now) {
		t.Fatalf("existing placement reward cannot be approved: %s", rec.Body.String())
	}
	if len(c.storage.curator.PendingReviews) != 1 {
		t.Fatal("approving an existing placement released a different queued post")
	}
}

func TestCuratorReviewDryRunApprovalNeverPublishesOrBecomesAReward(t *testing.T) {
	c, now := curatorFixture(t, false)
	setCuratorReview(t, c, true)
	note := curatorNote(t, "Dry-run proposal", *now, "")
	batch := seedCurator(t, c, note)
	curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", curatorDecisionRequest{"dry-review", batch, []CuratorDecision{curatorChoice(note, "arts", 21)}})
	request := pendingCuratorReview(t, c, note.ID.Hex(), "approve")
	rec := curatorRequest(t, c.ReviewHandler(), "POST", "/", "review-test", request)
	if rec.Code != 200 || len(c.storage.curator.Discoveries) != 0 || c.storage.curator.Proposals[0].Reward.Status != "dry_run" || c.storage.curator.Proposals[0].ReviewStatus != "approved" {
		t.Fatalf("dry-run approval had public effects: %s", rec.Body.String())
	}
	if len(c.storage.DiscoveriesForRewards()) != 0 || c.storage.CuratorSpendingAllowed(*now) {
		t.Fatal("dry-run approval can spend")
	}
	setCuratorReview(t, c, false)
	if len(c.storage.DiscoveriesForRewards()) != 0 {
		t.Fatal("turning review off converted a dry-run approval")
	}
}

func TestCuratorReviewRejectAndStaleAmountOrID(t *testing.T) {
	c, now := curatorFixture(t, true)
	setCuratorReview(t, c, true)
	note := curatorNote(t, "Candidate", *now, "")
	batch := seedCurator(t, c, note)
	curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", curatorDecisionRequest{"stale-review", batch, []CuratorDecision{curatorChoice(note, "arts", 100)}})
	request := pendingCuratorReview(t, c, note.ID.Hex(), "approve")
	for _, mutate := range []func(*curatorReviewRequest){
		func(r *curatorReviewRequest) { r.RewardSats = 500 },
		func(r *curatorReviewRequest) { r.ReviewID = strings.Repeat("f", 64) },
	} {
		stale := request
		mutate(&stale)
		if got := curatorRequest(t, c.ReviewHandler(), "POST", "/", "review-test", stale).Code; got != 409 {
			t.Fatal("stale or altered approval accepted")
		}
	}
	request.Action, request.RewardSats = "reject", 0
	for range 2 {
		if rec := curatorRequest(t, c.ReviewHandler(), "POST", "/", "review-test", request); rec.Code != 200 {
			t.Fatalf("rejection did not replay: %s", rec.Body.String())
		}
	}
	if len(c.storage.curator.Discoveries) != 0 || len(curatorReviewItems(c.storage.curator, *now)) != 0 || c.storage.curator.PendingReviews[note.ID.Hex()].ReviewStatus != "rejected" {
		t.Fatal("rejected proposal remained actionable")
	}
	request.Action, request.RewardSats = "approve", 100
	if got := curatorRequest(t, c.ReviewHandler(), "POST", "/", "review-test", request).Code; got != 409 {
		t.Fatal("rejected proposal was later approved")
	}
}

func TestCuratorReviewRechecksExpiryRemovalPauseAndCurrentBudget(t *testing.T) {
	for _, name := range []string{"expired", "removed", "paused", "budget"} {
		t.Run(name, func(t *testing.T) {
			c, now := curatorFixture(t, true)
			setCuratorReview(t, c, true)
			note := curatorNote(t, name, *now, "")
			batch := seedCurator(t, c, note)
			curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", curatorDecisionRequest{name, batch, []CuratorDecision{curatorChoice(note, "arts", 500)}})
			request := pendingCuratorReview(t, c, note.ID.Hex(), "approve")
			switch name {
			case "expired":
				*now = now.Add(curatorPlacement)
			case "removed":
				c.storage.removed[note.ID.Hex()] = true
			case "paused":
				c.storage.curator.Mode = curatorDisabled
			case "budget":
				c.storage.curator.DailyRewardSats = 100
			}
			if rec := curatorRequest(t, c.ReviewHandler(), "POST", "/", "review-test", request); rec.Code != 409 {
				t.Fatalf("approval bypassed %s: %s", name, rec.Body.String())
			}
			if len(c.storage.curator.PendingReviews) != 1 || len(c.storage.curator.Discoveries) != 0 {
				t.Fatal("failed approval changed the stored queue")
			}
		})
	}
}

func TestCuratorReviewSaveFailureRollsBackApprovalAndSettings(t *testing.T) {
	c, now := curatorFixture(t, true)
	setCuratorReview(t, c, true)
	note := curatorNote(t, "Durable approval", *now, "")
	batch := seedCurator(t, c, note)
	curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", curatorDecisionRequest{"save-review", batch, []CuratorDecision{curatorChoice(note, "arts", 100)}})
	request := pendingCuratorReview(t, c, note.ID.Hex(), "approve")
	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	c.storage.dataFile = filepath.Join(blocker, "data.json")
	if got := curatorRequest(t, c.ReviewHandler(), "POST", "/", "review-test", request).Code; got != 500 {
		t.Fatal("approval ignored a persistence failure")
	}
	if len(c.storage.curator.PendingReviews) != 1 || len(c.storage.curator.Discoveries) != 0 {
		t.Fatal("failed save released a reward")
	}
	if got := curatorRequest(t, c.ReviewHandler(), "POST", "/", "review-test", map[string]any{"action": "set_review", "review_required": false}).Code; got != 500 || !curatorReviewRequired(c.storage.curator) {
		t.Fatal("failed save disabled review")
	}
}

func TestCuratorReviewSnapshotHasOriginalsAndNoWalletJournal(t *testing.T) {
	c, now := curatorFixture(t, false)
	note := curatorNote(t, "Original text stays intact", *now, "")
	batch := seedCurator(t, c, note)
	curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", curatorDecisionRequest{"snapshot-review", batch, []CuratorDecision{curatorChoice(note, "arts", 100)}})
	c.storage.curator.Proposals[0].Reward.Invoice = "private-invoice-marker"
	c.storage.curator.Proposals[0].Reward.WalletID = "private-wallet-marker"
	rec := curatorRequest(t, c.ReviewHandler(), "GET", "/", "review-test", nil)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), note.Content) || strings.Contains(rec.Body.String(), "private-") {
		t.Fatalf("unsafe or incomplete review snapshot: %s", rec.Body.String())
	}
	var body struct {
		Pending int              `json:"pending_count"`
		Items   []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Pending != 1 || len(body.Items) != 1 {
		t.Fatal(fmt.Sprint(err), " incorrect review count")
	}
	if got := curatorRequest(t, c.ReviewHandler(), "GET", "/?offset=-1", "review-test", nil).Code; got != 400 {
		t.Fatal("negative pagination accepted")
	}
}

func TestCuratorReviewApprovalQueuesExactlyOneWalletSend(t *testing.T) {
	c, now := curatorFixture(t, true)
	setCuratorReview(t, c, true)
	note := curatorNote(t, "Only a human can release this reward", *now, "")
	batch := seedCurator(t, c, note)
	curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", curatorDecisionRequest{"wallet-review", batch, []CuratorDecision{curatorChoice(note, "arts", 21)}})
	executor, _, wallet := rewardExecutorFixture(t)
	executor.store, executor.now = c.storage, c.now
	executor.Process(context.Background())
	if wallet.pays != 0 {
		t.Fatal("wallet sent before review")
	}
	request := pendingCuratorReview(t, c, note.ID.Hex(), "approve")
	var workers sync.WaitGroup
	for range 2 {
		workers.Go(func() {
			if rec := curatorRequest(t, c.ReviewHandler(), "POST", "/", "review-test", request); rec.Code != 200 {
				t.Errorf("concurrent approval: %s", rec.Body.String())
			}
		})
	}
	workers.Wait()
	for range 2 {
		executor.Process(context.Background())
	}
	d, _ := c.storage.GetDiscovery(note.ID.Hex())
	if wallet.pays != 1 || d.Reward.Status != "paid" || len(c.storage.DiscoveryWaitingEntries(nil, *now)) != 1 {
		t.Fatalf("approval did not produce one placement and payment: %d / %s", wallet.pays, d.Reward.Status)
	}
}

func TestCuratorReviewTogglePreservesAnUncertainPaymentAndRecovery(t *testing.T) {
	c, now := curatorFixture(t, true)
	note := curatorNote(t, "Already attempted automatic reward", *now, "")
	batch := seedCurator(t, c, note)
	curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", curatorDecisionRequest{"inflight-review", batch, []CuratorDecision{curatorChoice(note, "arts", 21)}})
	executor, _, wallet := rewardExecutorFixture(t)
	executor.store, executor.now = c.storage, c.now
	wallet.payError = errors.New("lost wallet response")
	executor.Process(context.Background())
	setCuratorReview(t, c, true)
	if len(curatorReviewItems(c.storage.curator, *now)) != 0 {
		t.Fatal("in-flight payment became an approvable new payment")
	}
	*now = now.Add(5 * time.Minute)
	executor.Process(context.Background())
	d, _ := c.storage.GetDiscovery(note.ID.Hex())
	if wallet.pays != 1 || wallet.lookups != 1 || d.Reward.Status != "paid" {
		t.Fatalf("review toggle broke recovery: %d sends, %d lookups, %s", wallet.pays, wallet.lookups, d.Reward.Status)
	}
}

func TestCuratorReviewRejectingExistingPlacementKeepsPublicRewardCompatibility(t *testing.T) {
	c, now := curatorFixture(t, true)
	note := curatorNote(t, "Already visible, not yet paid", *now, "")
	batch := seedCurator(t, c, note)
	curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", curatorDecisionRequest{"public-review", batch, []CuratorDecision{curatorChoice(note, "arts", 21)}})
	setCuratorReview(t, c, true)
	request := pendingCuratorReview(t, c, note.ID.Hex(), "reject")
	if rec := curatorRequest(t, c.ReviewHandler(), "POST", "/", "review-test", request); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	entries := c.storage.DiscoveryWaitingEntries(nil, *now)
	if len(entries) != 1 || entries[0].Discovery.RewardStatus != "failed" || c.storage.DiscoverySpendingAllowed(note.ID.Hex(), *now) {
		t.Fatal("review rejection removed exposure or broke the public reward contract")
	}
}
