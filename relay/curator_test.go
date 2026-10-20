package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"fiatjaf.com/nostr"
)

func curatorRequest(t *testing.T, handler http.HandlerFunc, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var encoded []byte
	if body != nil {
		var err error
		encoded, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler(rec, req)
	return rec
}

func curatorFixture(t *testing.T, active bool) (*CuratorService, *time.Time) {
	t.Helper()
	config := DefaultCuratorConfig()
	config.Token = "curator-test"
	config.Mode = curatorDryRun
	config.ReviewRequired = false
	config.ReviewToken = "review-test"
	c := NewCuratorService(newTestStorage(t), NewPostFetcher(nil), config)
	if c.initErr != nil {
		t.Fatal(c.initErr)
	}
	now := time.Now().UTC()
	c.now = func() time.Time { return now }
	if active {
		c.storage.curator.DryRunStartedAt = now.Add(-8 * 24 * time.Hour)
		for day := 1; day <= 7; day++ {
			c.storage.curator.DryRunDays[curatorDay(now.Add(-time.Duration(day)*24*time.Hour))] = true
		}
		rec := curatorRequest(t, c.AdminHandler("admin-test"), "POST", "/", "admin-test", map[string]string{"mode": "active"})
		if rec.Code != 200 {
			t.Fatal(rec.Body.String())
		}
	}
	return c, &now
}

func curatorNote(t *testing.T, content string, at time.Time, secret string) *nostr.Event {
	t.Helper()
	if secret == "" {
		secret = generatePrivateKey()
	}
	event := &nostr.Event{Kind: 1, CreatedAt: nostr.Timestamp(at.Unix()), Content: content, Tags: nostr.Tags{}}
	if err := signEvent(event, secret); err != nil {
		t.Fatal(err)
	}
	return event
}

func seedCurator(t *testing.T, c *CuratorService, events ...*nostr.Event) string {
	t.Helper()
	for _, event := range events {
		c.storage.curator.Candidates[event.ID.Hex()] = &CuratorCandidate{event, []string{"wss://example.com"}, c.now()}
	}
	rec := curatorRequest(t, c.CandidatesHandler(), "GET", "/", "curator-test", nil)
	if rec.Code != 200 {
		t.Fatalf("batch: %s", rec.Body.String())
	}
	var response struct {
		BatchID string `json:"batch_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response.BatchID
}

func curatorChoice(event *nostr.Event, topic string, reward int64) CuratorDecision {
	return CuratorDecision{NoteID: event.ID.Hex(), Selected: true, Reason: "Original and useful work", Topic: topic, Language: "pl", Confidence: 0.9, RewardSats: reward}
}

func TestCuratorAuthenticationAndExplicitActivation(t *testing.T) {
	c, now := curatorFixture(t, false)
	for _, handler := range []http.HandlerFunc{c.CandidatesHandler(), c.StatusHandler()} {
		if got := curatorRequest(t, handler, "GET", "/", "wrong", nil).Code; got != 401 {
			t.Fatal(got)
		}
	}
	c.config.Token = ""
	if got := curatorRequest(t, c.StatusHandler(), "GET", "/", "", nil).Code; got != 401 {
		t.Fatal(got)
	}
	c.config.Token = "curator-test"
	for _, token := range []string{"curator-test", "admin-test"} {
		rec := curatorRequest(t, c.AdminHandler("admin-test"), "POST", "/", token, map[string]string{"mode": "active"})
		if rec.Code == 200 {
			t.Fatal("activated without dry run")
		}
	}
	*now = now.Add(7*24*time.Hour + time.Minute)
	if rec := curatorRequest(t, c.AdminHandler("admin-test"), "POST", "/", "admin-test", map[string]string{"mode": "active"}); rec.Code != 409 {
		t.Fatal("elapsed time replaced dry-run evidence")
	}
	for day := 1; day <= 7; day++ {
		c.storage.curator.DryRunDays[curatorDay(now.Add(-time.Duration(day)*24*time.Hour))] = true
	}
	if rec := curatorRequest(t, c.AdminHandler("admin-test"), "POST", "/", "admin-test", map[string]string{"mode": "active"}); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	deadline := c.storage.curator.PilotDeadline
	loaded, err := NewStorage(c.storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	config := c.config
	config.Mode = curatorActive
	restarted := NewCuratorService(loaded, nil, config)
	if !loaded.curator.PilotDeadline.Equal(deadline) || loaded.curator.ActiveStartedAt.IsZero() {
		t.Fatal("restart reset pilot")
	}
	if !loaded.CuratorSpendingAllowed(*now) || loaded.CuratorSpendingAllowed(deadline) {
		t.Fatal("pilot deadline not enforced")
	}
	restarted.now = func() time.Time { return deadline }
	if rec := curatorRequest(t, restarted.AdminHandler("admin-test"), "POST", "/", "admin-test", map[string]string{"mode": "active"}); rec.Code != 409 {
		t.Fatal("renewed expired pilot")
	}
	freshConfig := DefaultCuratorConfig()
	freshConfig.Mode = curatorActive
	fresh := NewCuratorService(newTestStorage(t), nil, freshConfig)
	if fresh.storage.CuratorMode() != curatorDisabled {
		t.Fatal("configuration bypassed activation")
	}
}

func TestCuratorDryRunReplayPersistenceAndBatchMembership(t *testing.T) {
	c, now := curatorFixture(t, false)
	note := curatorNote(t, "A worthwhile older post", now.Add(-60*24*time.Hour), "")
	batch := seedCurator(t, c, note)
	retry := seedCurator(t, c)
	if retry != batch || len(c.storage.curator.Batches) != 1 {
		t.Fatal("GET consumed another round")
	}
	request := curatorDecisionRequest{"run-1", batch, []CuratorDecision{curatorChoice(note, "science", 100)}}
	unknown := request
	unknown.Decisions = []CuratorDecision{curatorChoice(curatorNote(t, "unknown", *now, ""), "arts", 21)}
	if rec := curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", unknown); rec.Code != 400 {
		t.Fatal(rec.Body.String())
	}
	rec := curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", request)
	if rec.Code != 200 || len(c.storage.curator.Proposals) != 1 || len(c.storage.DiscoveriesForRewards()) != 0 || len(c.storage.posts) != 0 {
		t.Fatal(rec.Body.String())
	}
	loaded, err := NewStorage(c.storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	restarted := NewCuratorService(loaded, nil, c.config)
	replay := curatorRequest(t, restarted.DecisionsHandler(), "POST", "/", "curator-test", request)
	if replay.Body.String() != rec.Body.String() {
		t.Fatalf("replay changed: %s", replay.Body.String())
	}
	request.Decisions[0].Reason = "Different"
	if got := curatorRequest(t, restarted.DecisionsHandler(), "POST", "/", "curator-test", request).Code; got != 409 {
		t.Fatal(got)
	}
	completed := curatorRequest(t, restarted.CandidatesHandler(), "GET", "/", "curator-test", nil)
	var response struct {
		Candidates []any `json:"candidates"`
		Completed  bool  `json:"completed"`
	}
	_ = json.Unmarshal(completed.Body.Bytes(), &response)
	if !response.Completed || len(response.Candidates) != 0 {
		t.Fatal(completed.Body.String())
	}
}

func TestCuratorConcurrentAdmissionCapsAndReservations(t *testing.T) {
	c, now := curatorFixture(t, true)
	events := []*nostr.Event{}
	for i := 0; i < 8; i++ {
		events = append(events, curatorNote(t, fmt.Sprint(i), *now, ""))
	}
	batch := seedCurator(t, c, events...)
	// Two callers race the same issued batch. Only one transaction can reserve.
	var workers sync.WaitGroup
	for run := 0; run < 8; run++ {
		workers.Go(func() {
			request := curatorDecisionRequest{fmt.Sprint(run), batch, []CuratorDecision{curatorChoice(events[run], "arts", 500)}}
			rec := curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", request)
			if rec.Code != 200 && rec.Code != 409 {
				t.Errorf("status %d", rec.Code)
			}
		})
	}
	workers.Wait()
	if len(c.storage.DiscoveriesForRewards()) != 1 || curatorReserved(c.storage.curator, *now) != 500 {
		t.Fatal("concurrent batch admitted twice")
	}
	*now = now.Add(12 * time.Hour)
	remaining := []*nostr.Event{}
	for _, event := range events {
		if _, found := c.storage.GetDiscovery(event.ID.Hex()); !found {
			remaining = append(remaining, event)
		}
	}
	batch = seedCurator(t, c, remaining...)
	request := curatorDecisionRequest{"next-slot", batch, []CuratorDecision{curatorChoice(remaining[0], "arts", 500), curatorChoice(remaining[1], "science", 500), curatorChoice(remaining[2], "projects", 21)}}
	rec := curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", request)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	if reserved := curatorReserved(c.storage.curator, *now); reserved > 1000 {
		t.Fatalf("overspent %d", reserved)
	}
	// Pending reservations remain charged on a later UTC day.
	*now = now.Add(24 * time.Hour)
	if curatorReserved(c.storage.curator, *now) != 1000 {
		t.Fatal("midnight released unresolved reservation")
	}
	d := c.storage.DiscoveriesForRewards()[0]
	if err := c.storage.UpdateDiscoveryReward(d.NoteID, func(r *DiscoveryReward) error { r.Status = "unavailable"; return nil }); err != nil {
		t.Fatal(err)
	}
	if curatorReserved(c.storage.curator, *now) != 500 {
		t.Fatal("unavailable reservation not released")
	}
}

func TestCuratorAdmissionPolicyAndSignatureRecheck(t *testing.T) {
	c, now := curatorFixture(t, true)
	secret := generatePrivateKey()
	authorFirst := curatorNote(t, "one", *now, secret)
	sameAuthor := curatorNote(t, "two", *now, secret)
	bitcoin := curatorNote(t, "bitcoin", *now, "")
	again := curatorNote(t, "again", *now, "")
	bad := curatorNote(t, "valid before issue", *now, "")
	batch := seedCurator(t, c, authorFirst, sameAuthor, bitcoin, again, bad)
	// Corrupt the persisted batch snapshot, not the candidate cache.
	for _, issued := range c.storage.curator.Batches {
		issued.Candidates[bad.ID.Hex()].Event.Content = "tampered"
	}
	request := curatorDecisionRequest{"policy", batch, []CuratorDecision{curatorChoice(authorFirst, "arts", 21), curatorChoice(sameAuthor, "culture", 21), curatorChoice(bitcoin, "bitcoin_nostr", 21), curatorChoice(again, "bitcoin_nostr", 21), curatorChoice(bad, "science", 21)}}
	rec := curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", request)
	var response curatorDecisionResult
	_ = json.Unmarshal(rec.Body.Bytes(), &response)
	if rec.Code != 200 || len(response.Published) != 2 || len(response.Rejected) != 3 {
		t.Fatal(rec.Body.String())
	}
	for _, d := range c.storage.DiscoveriesForRewards() {
		if d.Reward.Status != "pending" || d.ExpiresAt.Sub(d.CreatedAt) != 7*24*time.Hour {
			t.Fatal("wrong admission state")
		}
	}
	if len(c.storage.posts) != 0 || len(c.storage.accountPublications) != 0 {
		t.Fatal("discovery added paid rank or publication")
	}
}

func TestCuratorRejectsPromotedRemovedDiscoveredAndExpiredBatch(t *testing.T) {
	c, now := curatorFixture(t, true)
	paid := curatorNote(t, "expired promotion", *now, "")
	c.storage.posts[paid.ID.Hex()] = &PromotedPost{PostID: paid.ID.Hex(), Event: paid, TotalSatsPaid: 1, LastPaymentTimestamp: now.Add(-5 * 365 * 24 * time.Hour)}
	removed := curatorNote(t, "removed", *now, "")
	c.storage.removed[removed.ID.Hex()] = true
	already := curatorNote(t, "already discovered", *now, "")
	c.storage.curator.Discoveries[already.ID.Hex()] = &Discovery{NoteID: already.ID.Hex(), Event: already, CreatedAt: now.Add(-40 * 24 * time.Hour), ExpiresAt: now.Add(-33 * 24 * time.Hour)}
	for _, event := range []*nostr.Event{paid, removed, already} {
		if c.eligibleLocked(c.storage.curator, &CuratorCandidate{Event: event}, *now) == "" {
			t.Fatal("previous event eligible")
		}
	}
	fresh := curatorNote(t, "fresh", *now, "")
	batch := seedCurator(t, c, fresh)
	*now = now.Add(25 * time.Hour)
	if rec := curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", curatorDecisionRequest{"expired", batch, []CuratorDecision{curatorChoice(fresh, "arts", 21)}}); rec.Code != 410 {
		t.Fatal(rec.Body.String())
	}
}

func TestCuratorSaveFailureRollsBackBatchAndAdmission(t *testing.T) {
	c, now := curatorFixture(t, true)
	note := curatorNote(t, "one", *now, "")
	batch := seedCurator(t, c, note)
	originalFile := c.storage.dataFile
	c.storage.dataFile = filepath.Join(t.TempDir(), "missing", "store.json")
	// Atomic storage creates parent directories, so use a file as the parent.
	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	c.storage.dataFile = filepath.Join(blocker, "store.json")
	request := curatorDecisionRequest{"rollback", batch, []CuratorDecision{curatorChoice(note, "arts", 100)}}
	if rec := curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", request); rec.Code != 500 {
		t.Fatal(rec.Body.String())
	}
	if len(c.storage.curator.Discoveries) != 0 || c.storage.curator.Runs["rollback"] != nil {
		t.Fatal("save failure retained admission")
	}
	c.storage.dataFile = originalFile
	if rec := curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", request); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	clone, _ := c.storage.GetDiscovery(note.ID.Hex())
	clone.Event.Content = "modified"
	clone.Reward.Status = "paid"
	stored, _ := c.storage.GetDiscovery(note.ID.Hex())
	if stored.Event.Content == clone.Event.Content || stored.Reward.Status == "paid" {
		t.Fatal("discovery getter leaked mutable state")
	}
}

func TestCuratorPauseAndRemovalBlockClaimsButAllowReconciliation(t *testing.T) {
	c, now := curatorFixture(t, true)
	note := curatorNote(t, "claim", *now, "")
	batch := seedCurator(t, c, note)
	curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", curatorDecisionRequest{"claim", batch, []CuratorDecision{curatorChoice(note, "arts", 21)}})
	id := note.ID.Hex()
	if !c.storage.DiscoverySpendingAllowed(id, *now) {
		t.Fatal("active discovery cannot spend")
	}
	c.storage.removed[id] = true
	if err := c.storage.UpdateDiscoveryReward(id, func(r *DiscoveryReward) error { r.Status = "preparing"; return nil }); err == nil {
		t.Fatal("removed reward claimed")
	}
	delete(c.storage.removed, id)
	if err := c.storage.UpdateDiscoveryReward(id, func(r *DiscoveryReward) error { r.Status = "preparing"; return nil }); err != nil {
		t.Fatal(err)
	}
	curatorRequest(t, c.AdminHandler("admin-test"), "POST", "/", "admin-test", map[string]string{"mode": "disabled"})
	if err := c.storage.UpdateDiscoveryReward(id, func(r *DiscoveryReward) error { r.Status = "sending"; return nil }); err == nil {
		t.Fatal("paused reward sent")
	}
	if err := c.storage.UpdateDiscoveryReward(id, func(r *DiscoveryReward) error { r.Status = "paid"; r.SettledAt = *now; return nil }); err != nil {
		t.Fatal(err)
	}
	if len(c.storage.DiscoveriesForRewards()) != 1 || curatorReserved(c.storage.curator, *now) != 21 {
		t.Fatal("pause lost settlement journal")
	}
}

func TestCuratorCollectorBoundsAndOlderSignedNotes(t *testing.T) {
	c, now := curatorFixture(t, false)
	c.config.Relays = []string{"wss://one.example", "wss://two.example", "wss://three.example", "wss://four.example"}
	older := curatorNote(t, "História e ciência", now.Add(-70*24*time.Hour), "")
	tooOld := curatorNote(t, "too old", now.Add(-91*24*time.Hour), "")
	var running, maxRunning atomic.Int32
	var calls atomic.Int32
	c.query = func(ctx context.Context, source string, filter nostr.Filter) ([]*nostr.Event, error) {
		calls.Add(1)
		n := running.Add(1)
		for old := maxRunning.Load(); n > old; old = maxRunning.Load() {
			if maxRunning.CompareAndSwap(old, n) {
				break
			}
		}
		defer running.Add(-1)
		return []*nostr.Event{older, tooOld}, nil
	}
	c.writeRelays = func(context.Context, string, []string) []string {
		return []string{"wss://author.example", "ws://127.0.0.1:1", "file:///bad"}
	}
	c.collect(context.Background())
	if maxRunning.Load() > 4 || calls.Load() > 16 {
		t.Fatalf("collector budgets exceeded: %d/%d", maxRunning.Load(), calls.Load())
	}
	if len(c.storage.curator.Candidates) != 1 || c.storage.curator.Candidates[older.ID.Hex()] == nil {
		t.Fatal("collector lost older valid multilingual note")
	}
	if !c.storage.curator.LastCollectedAt.Equal(*now) {
		t.Fatal("collection not persisted")
	}
	loaded, err := NewStorage(c.storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.curator.Candidates) != 1 {
		t.Fatal("candidate disappeared after restart")
	}
	curatorRequest(t, c.AdminHandler("admin-test"), "POST", "/", "admin-test", map[string]string{"mode": "disabled"})
	before := calls.Load()
	c.collect(context.Background())
	if calls.Load() != before {
		t.Fatal("disabled collector contacted relays")
	}
}

func TestCuratorCollectorReadsNotesWhenTextSearchIsUnsupported(t *testing.T) {
	c, now := curatorFixture(t, false)
	*now = time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	for int(now.Unix()/3600)%13 == 0 {
		*now = now.Add(4 * time.Hour)
	}
	c.config.Relays = []string{"wss://ordinary.example"}
	note := curatorNote(t, "A useful community project", now.Add(-time.Hour), "")
	var searches atomic.Int32
	c.query = func(_ context.Context, _ string, filter nostr.Filter) ([]*nostr.Event, error) {
		if filter.Search != "" {
			searches.Add(1)
			return nil, fmt.Errorf("unrecognised filter item: search")
		}
		return []*nostr.Event{note}, nil
	}
	c.writeRelays = func(context.Context, string, []string) []string { return nil }
	c.collect(context.Background())
	if c.storage.curator.Candidates[note.ID.Hex()] == nil || !c.storage.curator.LastCollectedAt.Equal(*now) {
		t.Fatal("unsupported text search prevented ordinary post collection")
	}
	collection := c.storage.curator.LastCollection
	if searches.Load() != 1 || collection.Failed != 1 || collection.Completed < 1 {
		t.Fatalf("search failures and successful reads were not reported separately: %+v", collection)
	}
}

func TestCuratorConfiguredLimitsAndActivationCheck(t *testing.T) {
	c, now := curatorFixture(t, true)
	config := c.config
	config.Mode = curatorActive
	config.DailyDiscoveries = 1
	config.DailyRewardSats = 21
	restarted := NewCuratorService(c.storage, nil, config)
	if restarted.storage.curator.DailyDiscoveries != 1 || restarted.storage.curator.DailyRewardSats != 21 {
		t.Fatal("restart retained larger limits")
	}
	events := []*nostr.Event{curatorNote(t, "first", *now, ""), curatorNote(t, "second", *now, "")}
	batch := seedCurator(t, restarted, events...)
	rec := curatorRequest(t, restarted.DecisionsHandler(), "POST", "/", "curator-test", curatorDecisionRequest{"limited", batch, []CuratorDecision{curatorChoice(events[0], "arts", 21), curatorChoice(events[1], "culture", 21)}})
	var result curatorDecisionResult
	_ = json.Unmarshal(rec.Body.Bytes(), &result)
	if len(result.Published) != 1 || len(result.Rejected) != 1 {
		t.Fatal(rec.Body.String())
	}
	restarted.activationCheck = func() error { return fmt.Errorf("wallet missing") }
	if rec := curatorRequest(t, restarted.AdminHandler("admin-test"), "POST", "/", "admin-test", map[string]string{"mode": "active"}); rec.Code != 409 {
		t.Fatal("activation check bypassed")
	}
	config.DailyDiscoveries = 0
	invalid := NewCuratorService(c.storage, nil, config)
	if invalid.initErr == nil || invalid.storage.CuratorSpendingAllowed(*now) {
		t.Fatal("invalid limits failed open")
	}
}

func TestCuratorDryRunConfigurationEnablesPersistedDisabledState(t *testing.T) {
	config := DefaultCuratorConfig()
	storage := newTestStorage(t)
	disabled := NewCuratorService(storage, nil, config)
	if disabled.initErr != nil {
		t.Fatal(disabled.initErr)
	}
	loaded, err := NewStorage(storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	config.Mode = curatorDryRun
	started := NewCuratorService(loaded, nil, config)
	if started.initErr != nil || loaded.CuratorMode() != curatorDryRun || loaded.curator.DryRunStartedAt.IsZero() {
		t.Fatal("dry-run configuration did not enable a persisted disabled installation")
	}
	firstStartedAt := loaded.curator.DryRunStartedAt
	loaded.curator.DryRunDays[curatorDay(firstStartedAt)] = true
	loaded.curator.ActiveStartedAt = firstStartedAt.Add(7 * 24 * time.Hour)
	loaded.curator.PilotDeadline = firstStartedAt.Add(37 * 24 * time.Hour)
	deadline := loaded.curator.PilotDeadline
	config.Mode = curatorDisabled
	paused := NewCuratorService(loaded, nil, config)
	if paused.initErr != nil {
		t.Fatal(paused.initErr)
	}
	reloaded, err := NewStorage(storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	config.Mode = curatorDryRun
	resumed := NewCuratorService(reloaded, nil, config)
	if resumed.initErr != nil || reloaded.CuratorMode() != curatorDryRun || !reloaded.curator.DryRunStartedAt.Equal(firstStartedAt) || len(reloaded.curator.DryRunDays) != 1 || !reloaded.curator.PilotDeadline.Equal(deadline) {
		t.Fatal("resuming dry run reset durable evidence or pilot deadline")
	}
}

func TestCuratorPolicyValidationAndRollingTopicWindow(t *testing.T) {
	c, now := curatorFixture(t, true)
	note := curatorNote(t, "valid", *now, "")
	candidate := &CuratorCandidate{Event: note}
	base := curatorChoice(note, "arts", 21)
	for _, mutate := range []func(*CuratorDecision){func(d *CuratorDecision) { d.Reason = "" }, func(d *CuratorDecision) { d.Confidence = 0.69 }, func(d *CuratorDecision) { d.Topic = "anything" }, func(d *CuratorDecision) { d.RewardSats = 22 }, func(d *CuratorDecision) { d.Language = "" }} {
		decision := base
		mutate(&decision)
		if curatorPolicyError(c.storage.curator, candidate, decision, *now) == "" {
			t.Fatal("invalid decision accepted")
		}
	}
	for i := 0; i < 4; i++ {
		older := curatorNote(t, fmt.Sprint(i), now.Add(-48*time.Hour), "")
		topic := "culture"
		if i == 0 {
			topic = "bitcoin_nostr"
		}
		c.storage.curator.Discoveries[older.ID.Hex()] = &Discovery{NoteID: older.ID.Hex(), Event: older, Topic: topic, CreatedAt: now.Add(-48 * time.Hour), Sequence: uint64(i + 1)}
	}
	bitcoin := base
	bitcoin.Topic = "bitcoin_nostr"
	if curatorPolicyError(c.storage.curator, candidate, bitcoin, *now) == "" {
		t.Fatal("second Bitcoin/Nostr in rolling five accepted")
	}
	older := curatorNote(t, "fifth", now.Add(-48*time.Hour), "")
	c.storage.curator.Discoveries[older.ID.Hex()] = &Discovery{NoteID: older.ID.Hex(), Event: older, Topic: "arts", CreatedAt: now.Add(-48 * time.Hour), Sequence: 5}
	if err := curatorPolicyError(c.storage.curator, candidate, bitcoin, *now); err != "" {
		t.Fatal(err)
	}
}

func TestCuratorInitializationFailureKeepsRewardsPaused(t *testing.T) {
	c, now := curatorFixture(t, true)
	note := curatorNote(t, "preserved", *now, "")
	batch := seedCurator(t, c, note)
	curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", curatorDecisionRequest{"before-startup-failure", batch, []CuratorDecision{curatorChoice(note, "arts", 21)}})
	path := c.storage.dataFile
	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	c.storage.dataFile = filepath.Join(blocker, "data.json")
	config := c.config
	config.Mode = curatorDisabled
	restarted := NewCuratorService(c.storage, nil, config)
	c.storage.dataFile = path
	if restarted.initErr == nil || c.storage.CuratorSpendingAllowed(*now) || c.storage.DiscoverySpendingAllowed(note.ID.Hex(), *now) {
		t.Fatal("failed startup left spending active")
	}
	if err := c.storage.UpdateDiscoveryReward(note.ID.Hex(), func(r *DiscoveryReward) error { r.Status = "preparing"; return nil }); err == nil {
		t.Fatal("failed startup allowed a claim")
	}
	if err := c.storage.UpdateDiscoveryReward(note.ID.Hex(), func(r *DiscoveryReward) error { r.Status = "paid"; r.SettledAt = *now; return nil }); err != nil {
		t.Fatal("failed startup prevented reconciliation")
	}
}

func TestCuratorJournalCapacityPreservesReplay(t *testing.T) {
	c, now := curatorFixture(t, false)
	note := curatorNote(t, "proposal", *now, "")
	batch := seedCurator(t, c, note)
	request := curatorDecisionRequest{"original", batch, []CuratorDecision{curatorChoice(note, "arts", 21)}}
	original := curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", request)
	for i := len(c.storage.curator.Runs); i < curatorRunLimit; i++ {
		c.storage.curator.Runs[fmt.Sprint(i)] = &curatorRun{}
	}
	replayed := curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", request)
	if replayed.Code != 200 || original.Body.String() != replayed.Body.String() {
		t.Fatal("full journal lost replay")
	}
	request.RunID = "new"
	if rec := curatorRequest(t, c.DecisionsHandler(), "POST", "/", "curator-test", request); rec.Code != 409 {
		t.Fatal("journal capacity bypassed")
	}
	for i := 0; i < curatorCandidateLimit+10; i++ {
		c.storage.curator.Rejected[fmt.Sprint(i)] = *now
	}
	c.pruneLocked(c.storage.curator, *now)
	if len(c.storage.curator.Rejected) > curatorCandidateLimit {
		t.Fatal("rejected cache unbounded")
	}
}

func TestCuratorBoundsFullEventAndCandidateBytes(t *testing.T) {
	c, now := curatorFixture(t, false)
	secret := generatePrivateKey()
	oversized := curatorNote(t, "short content", *now, secret)
	oversized.Tags = nostr.Tags{{"large", strings.Repeat("x", curatorEventBytes)}}
	if err := signEvent(oversized, secret); err != nil {
		t.Fatal(err)
	}
	if validCuratorEvent(oversized, *now) {
		t.Fatal("oversized signed tags bypassed event limit")
	}
	note := curatorNote(t, strings.Repeat("a", 60*1024), *now, secret)
	if !validCuratorEvent(note, *now) {
		t.Fatal("bounded event rejected")
	}
	for i := 0; i < 150; i++ {
		c.storage.curator.Candidates[fmt.Sprintf("%04d", i)] = &CuratorCandidate{note, []string{"wss://example.com"}, now.Add(-time.Duration(i) * time.Minute)}
	}
	c.pruneLocked(c.storage.curator, *now)
	total := 0
	for _, candidate := range c.storage.curator.Candidates {
		data, _ := json.Marshal(candidate)
		total += len(data)
	}
	if total > curatorCandidateBytes || len(c.storage.curator.Candidates) >= 150 || c.storage.curator.Candidates["0000"] == nil {
		t.Fatalf("candidate bytes not bounded: %d", total)
	}
}
