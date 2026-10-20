package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"fiatjaf.com/nostr"
)

const (
	curatorDisabled       = "disabled"
	curatorDryRun         = "dry_run"
	curatorActive         = "active"
	curatorCandidateLimit = 2000
	curatorCandidateBytes = 8 * 1024 * 1024
	curatorEventBytes     = 64 * 1024
	curatorBatchLimit     = 50
	curatorRunLimit       = 512
	curatorReviewLimit    = 100
	curatorBatchTTL       = 24 * time.Hour
	curatorPlacement      = 7 * 24 * time.Hour
)

type Discovery struct {
	Sequence     uint64          `json:"sequence"`
	NoteID       string          `json:"note_id"`
	Event        *nostr.Event    `json:"event"`
	Reason       string          `json:"reason"`
	Topic        string          `json:"topic"`
	Language     string          `json:"language"`
	Confidence   float64         `json:"confidence"`
	CreatedAt    time.Time       `json:"created_at"`
	ExpiresAt    time.Time       `json:"expires_at"`
	SourceRelays []string        `json:"source_relays"`
	Reward       DiscoveryReward `json:"reward"`
	ReviewStatus string          `json:"review_status,omitempty"`
	ReviewID     string          `json:"review_id,omitempty"`
	ReviewedAt   time.Time       `json:"reviewed_at,omitempty"`
}

type CuratorConfig struct {
	Token            string
	Mode             string
	IdentityPubkey   string
	Relays           []string
	DailyRewardSats  int64
	DailyDiscoveries int
	ReviewRequired   bool
	ReviewToken      string
}

func DefaultCuratorConfig() CuratorConfig {
	return CuratorConfig{Mode: curatorDisabled, DailyRewardSats: 1000, DailyDiscoveries: 3, ReviewRequired: true}
}

type CuratorCandidate struct {
	Event        *nostr.Event `json:"event"`
	SourceRelays []string     `json:"source_relays"`
	FirstSeenAt  time.Time    `json:"first_seen_at"`
}

type curatorBatch struct {
	ID         string                       `json:"id"`
	Slot       string                       `json:"slot"`
	CreatedAt  time.Time                    `json:"created_at"`
	Candidates map[string]*CuratorCandidate `json:"candidates"`
	Completed  bool                         `json:"completed"`
}

type CuratorDecision struct {
	NoteID     string  `json:"note_id"`
	Selected   bool    `json:"selected"`
	Reason     string  `json:"reason"`
	Topic      string  `json:"topic"`
	Language   string  `json:"language"`
	Confidence float64 `json:"confidence"`
	RewardSats int64   `json:"reward_sats"`
}

type curatorDecisionRequest struct {
	RunID     string            `json:"run_id"`
	BatchID   string            `json:"batch_id"`
	Decisions []CuratorDecision `json:"decisions"`
}

type curatorRejection struct {
	NoteID string `json:"note_id"`
	Reason string `json:"reason"`
}

type curatorDecisionResult struct {
	RunID     string             `json:"run_id"`
	Mode      string             `json:"mode"`
	Published []string           `json:"published"`
	Proposed  []string           `json:"proposed"`
	Rejected  []curatorRejection `json:"rejected"`
}

type curatorRun struct {
	RequestDigest string                `json:"request_digest"`
	Result        curatorDecisionResult `json:"result"`
	CreatedAt     time.Time             `json:"created_at"`
}

type curatorState struct {
	NextSequence     uint64                       `json:"next_sequence"`
	Mode             string                       `json:"mode"`
	DryRunStartedAt  time.Time                    `json:"dry_run_started_at"`
	DryRunDays       map[string]bool              `json:"dry_run_days"`
	ActiveStartedAt  time.Time                    `json:"active_started_at"`
	PilotDeadline    time.Time                    `json:"pilot_deadline"`
	DailyRewardSats  int64                        `json:"daily_reward_sats"`
	DailyDiscoveries int                          `json:"daily_discoveries"`
	Discoveries      map[string]*Discovery        `json:"discoveries"`
	Proposals        []*Discovery                 `json:"proposals"`
	Candidates       map[string]*CuratorCandidate `json:"candidates"`
	Batches          map[string]*curatorBatch     `json:"batches"`
	Runs             map[string]*curatorRun       `json:"runs"`
	Rejected         map[string]time.Time         `json:"rejected"`
	ReviewRequired   *bool                        `json:"review_required,omitempty"`
	PendingReviews   map[string]*Discovery        `json:"pending_reviews,omitempty"`
	LastCollectedAt  time.Time                    `json:"last_collected_at"`
	LastCollection   curatorCollectionStatus      `json:"last_collection"`
}

type CuratorService struct {
	storage         *Storage
	fetcher         *PostFetcher
	config          CuratorConfig
	now             func() time.Time
	query           curatorQueryFunc
	writeRelays     func(context.Context, string, []string) []string
	initErr         error
	activationCheck func() error
}

func NewCuratorService(storage *Storage, fetcher *PostFetcher, config CuratorConfig) *CuratorService {
	var configErr error
	if config.DailyRewardSats <= 0 || config.DailyRewardSats > 1000 {
		configErr = fmt.Errorf("daily reward budget must be between 1 and 1000 sats")
	}
	if config.DailyDiscoveries <= 0 || config.DailyDiscoveries > 3 {
		configErr = fmt.Errorf("daily discovery limit must be between 1 and 3")
	}
	if configErr != nil {
		config.Mode = curatorDisabled
	}
	if config.Mode != curatorDryRun && config.Mode != curatorActive {
		config.Mode = curatorDisabled
	}
	config.Relays = safeRelayCandidates(config.Relays)
	c := &CuratorService{storage: storage, fetcher: fetcher, config: config, now: time.Now, query: queryCuratorRelay, writeRelays: authorWriteRelays}
	storage.mu.Lock()
	defer storage.mu.Unlock()
	previous := storage.curator
	state := cloneCuratorState(previous)
	if state == nil {
		state = &curatorState{Mode: curatorDisabled, DailyRewardSats: config.DailyRewardSats, DailyDiscoveries: config.DailyDiscoveries}
	}
	if config.Mode == curatorDisabled {
		state.Mode = curatorDisabled
	} else if config.Mode == curatorDryRun {
		state.Mode = curatorDryRun
		if state.DryRunStartedAt.IsZero() {
			state.DryRunStartedAt = c.now().UTC()
		}
	}
	state.DailyRewardSats = config.DailyRewardSats
	state.DailyDiscoveries = config.DailyDiscoveries
	if state.ReviewRequired == nil {
		required := config.ReviewRequired
		state.ReviewRequired = &required
	}
	state.initMaps()
	storage.curator = state
	if err := storage.save(); err != nil {
		storage.curator = previous
		c.initErr = err
	}
	if configErr != nil {
		c.initErr = configErr
	}
	storage.curatorUnavailable = c.initErr != nil
	return c
}

func (s *curatorState) initMaps() {
	if s.DryRunDays == nil {
		s.DryRunDays = map[string]bool{}
	}
	if s.Discoveries == nil {
		s.Discoveries = map[string]*Discovery{}
	}
	if s.Candidates == nil {
		s.Candidates = map[string]*CuratorCandidate{}
	}
	if s.Batches == nil {
		s.Batches = map[string]*curatorBatch{}
	}
	if s.Runs == nil {
		s.Runs = map[string]*curatorRun{}
	}
	if s.Rejected == nil {
		s.Rejected = map[string]time.Time{}
	}
	if s.PendingReviews == nil {
		s.PendingReviews = map[string]*Discovery{}
	}
}

func cloneCuratorState(state *curatorState) *curatorState {
	if state == nil {
		return nil
	}
	// State contains only persisted values. Copying through JSON also owns nested
	// event tags, reward requests and batch snapshots before any transaction.
	data, _ := json.Marshal(state)
	var copy curatorState
	_ = json.Unmarshal(data, &copy)
	copy.initMaps()
	return &copy
}

func cloneDiscovery(d *Discovery) *Discovery {
	if d == nil {
		return nil
	}
	copy := *d
	copy.Event = cloneNostrEvent(d.Event)
	copy.SourceRelays = append([]string(nil), d.SourceRelays...)
	copy.Reward.ZapRequest = cloneNostrEvent(d.Reward.ZapRequest)
	if d.Reward.FeesPaidMsat != nil {
		fees := *d.Reward.FeesPaidMsat
		copy.Reward.FeesPaidMsat = &fees
	}
	return &copy
}

func (s *Storage) GetDiscovery(id string) (*Discovery, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.curator == nil {
		return nil, false
	}
	d, ok := s.curator.Discoveries[id]
	return cloneDiscovery(d), ok
}

func (s *Storage) DiscoveriesForRewards() []*Discovery {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := []*Discovery{}
	if s.curator != nil {
		for _, d := range s.curator.Discoveries {
			result = append(result, cloneDiscovery(d))
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].CreatedAt.Equal(result[j].CreatedAt) {
			return result[i].NoteID < result[j].NoteID
		}
		return result[i].CreatedAt.Before(result[j].CreatedAt)
	})
	return result
}

func (s *Storage) UpdateDiscoveryReward(id string, update func(*DiscoveryReward) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.curator == nil || s.curator.Discoveries[id] == nil {
		return fmt.Errorf("unknown discovery")
	}
	before := s.curator.Discoveries[id]
	next := cloneDiscovery(before)
	if err := update(&next.Reward); err != nil {
		return err
	}
	if next.Reward.AmountSats != before.Reward.AmountSats {
		return fmt.Errorf("discovery reward amount is immutable")
	}
	if next.Reward.Status != before.Reward.Status && (next.Reward.Status == "preparing" || next.Reward.Status == "sending") && !s.discoverySpendingAllowedLocked(id, time.Now()) {
		return fmt.Errorf("discovery spending is paused or unavailable")
	}
	s.curator.Discoveries[id] = next
	if err := s.save(); err != nil {
		s.curator.Discoveries[id] = before
		return err
	}
	return nil
}

func (s *Storage) CuratorMode() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.curator == nil {
		return curatorDisabled
	}
	return s.curator.Mode
}

func (s *Storage) CuratorSpendingAllowed(now time.Time) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return !s.curatorUnavailable && curatorIsActive(s.curator, now)
}

func (s *Storage) DiscoverySpendingAllowed(id string, now time.Time) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.discoverySpendingAllowedLocked(id, now)
}

func (s *Storage) discoverySpendingAllowedLocked(id string, now time.Time) bool {
	if s.curatorUnavailable || !curatorIsActive(s.curator, now) || s.removed[id] {
		return false
	}
	d := s.curator.Discoveries[id]
	return d != nil && d.ExpiresAt.After(now) && (!curatorReviewRequired(s.curator) || d.ReviewStatus == "approved") &&
		(d.Reward.Status == "pending" || d.Reward.Status == "preparing")
}

func curatorReviewRequired(state *curatorState) bool {
	return state.ReviewRequired == nil || *state.ReviewRequired
}

func curatorIsActive(s *curatorState, now time.Time) bool {
	return s != nil && s.Mode == curatorActive && !s.ActiveStartedAt.IsZero() && !s.PilotDeadline.IsZero() && now.Before(s.PilotDeadline)
}

func curatorDay(t time.Time) string { return t.UTC().Format("2006-01-02") }

func curatorHistory(s *curatorState) []*Discovery {
	var history []*Discovery
	if s.Mode == curatorDryRun {
		history = append(history, s.Proposals...)
	}
	for _, d := range s.Discoveries {
		history = append(history, d)
	}
	for _, d := range s.PendingReviews {
		if d.ReviewStatus == "pending" {
			history = append(history, d)
		}
	}
	sort.Slice(history, func(i, j int) bool {
		if history[i].CreatedAt.Equal(history[j].CreatedAt) {
			if history[i].Sequence != history[j].Sequence {
				return history[i].Sequence < history[j].Sequence
			}
			return history[i].NoteID < history[j].NoteID
		}
		return history[i].CreatedAt.Before(history[j].CreatedAt)
	})
	return history
}

func curatorReserved(s *curatorState, now time.Time) int64 {
	var amount int64
	for _, d := range s.Discoveries {
		switch d.Reward.Status {
		case "pending", "preparing", "sending", "uncertain":
			amount = curatorBudgetAdd(amount, d.Reward.AmountSats)
		case "paid":
			if curatorDay(d.Reward.SettledAt) == curatorDay(now) {
				amount = curatorBudgetAdd(amount, d.Reward.AmountSats)
			}
		}
	}
	return amount
}

func curatorBudgetAdd(total, amount int64) int64 {
	if amount < 0 || total > math.MaxInt64-amount {
		return math.MaxInt64
	}
	return total + amount
}

func validCuratorEvent(event *nostr.Event, now time.Time) bool {
	if event == nil || (event.Kind != 1 && event.Kind != 1111) || strings.TrimSpace(event.Content) == "" || len(event.Content) > 64000 || event.CreatedAt > nostr.Timestamp(now.Add(5*time.Minute).Unix()) {
		return false
	}
	encoded, err := json.Marshal(event)
	if err != nil || len(encoded) > curatorEventBytes {
		return false
	}
	// VerifySignature is called on an owned clone: never trust a relay or a
	// previous validation result attached to a cached event.
	valid, err := verifyNostrEvent(cloneNostrEvent(event))
	return err == nil && valid
}

func (c *CuratorService) eligibleLocked(state *curatorState, candidate *CuratorCandidate, now time.Time) string {
	if candidate == nil || !validCuratorEvent(candidate.Event, now) {
		return "invalid event"
	}
	id := candidate.Event.ID.Hex()
	if c.config.IdentityPubkey != "" && candidate.Event.PubKey.Hex() == c.config.IdentityPubkey {
		return "board account"
	}
	if c.storage.removed[id] {
		return "removed"
	}
	if c.storage.posts[id] != nil || c.storage.accountPublications[quotePublicationKey(id)] != nil {
		return "previously promoted"
	}
	if state.Discoveries[id] != nil {
		return "already discovered"
	}
	if state.PendingReviews[id] != nil {
		return "already reviewed or awaiting review"
	}
	if state.Mode == curatorDryRun {
		for _, proposal := range state.Proposals {
			if proposal.NoteID == id {
				return "already proposed"
			}
		}
	}
	return ""
}

func curatorPolicyError(state *curatorState, candidate *CuratorCandidate, d CuratorDecision, now time.Time) string {
	if utf8.RuneCountInString(strings.TrimSpace(d.Reason)) < 1 || utf8.RuneCountInString(d.Reason) > 280 {
		return "reason must have 1 to 280 characters"
	}
	if d.Confidence < 0.7 || d.Confidence > 1 {
		return "confidence must be between 0.7 and 1"
	}
	switch d.Topic {
	case "arts", "science", "culture", "practical", "community", "projects", "personal", "bitcoin_nostr", "other":
	default:
		return "invalid topic"
	}
	if utf8.RuneCountInString(d.Language) < 1 || len(d.Language) > 64 {
		return "language is required (up to 64 bytes)"
	}
	if d.RewardSats != 21 && d.RewardSats != 100 && d.RewardSats != 500 {
		return "reward must be 21, 100 or 500 sats"
	}
	history := curatorHistory(state)
	count := 0
	for _, previous := range history {
		if curatorDay(previous.CreatedAt) == curatorDay(now) {
			count++
		}
		if previous.Event.PubKey == candidate.Event.PubKey && !previous.CreatedAt.Before(now.Add(-30*24*time.Hour)) {
			return "author already selected within 30 days"
		}
	}
	if count >= state.DailyDiscoveries {
		return "daily discovery limit"
	}
	reserved := curatorReserved(state, now)
	for _, proposal := range state.PendingReviews {
		if proposal.ReviewStatus == "pending" && curatorDay(proposal.CreatedAt) == curatorDay(now) {
			reserved = curatorBudgetAdd(reserved, proposal.Reward.AmountSats)
		}
	}
	if state.Mode == curatorDryRun {
		for _, proposal := range state.Proposals {
			if curatorDay(proposal.CreatedAt) == curatorDay(now) {
				reserved = curatorBudgetAdd(reserved, proposal.Reward.AmountSats)
			}
		}
	}
	if reserved > state.DailyRewardSats-d.RewardSats {
		return "daily reward budget"
	}
	if d.Topic == "bitcoin_nostr" {
		for _, previous := range history[max(0, len(history)-4):] {
			if previous.Topic == "bitcoin_nostr" {
				return "Bitcoin/Nostr topic limit"
			}
		}
	}
	return ""
}

func (c *CuratorService) pruneLocked(state *curatorState, now time.Time) {
	for id, proposal := range state.PendingReviews {
		if proposal.ReviewStatus == "pending" && !proposal.ExpiresAt.After(now) {
			proposal.ReviewStatus, proposal.Reward.Status = "expired", "expired"
		}
		if now.Sub(proposal.CreatedAt) > 30*24*time.Hour {
			delete(state.PendingReviews, id)
		}
	}
	for id, batch := range state.Batches {
		if now.Sub(batch.CreatedAt) >= curatorBatchTTL {
			delete(state.Batches, id)
		}
	}
	for id, t := range state.Rejected {
		if now.Sub(t) > 30*24*time.Hour {
			delete(state.Rejected, id)
		}
	}
	for len(state.Rejected) > curatorCandidateLimit {
		var oldest string
		for id, t := range state.Rejected {
			if oldest == "" || t.Before(state.Rejected[oldest]) {
				oldest = id
			}
		}
		delete(state.Rejected, oldest)
	}
	for id, candidate := range state.Candidates {
		if now.Sub(candidate.FirstSeenAt) > 7*24*time.Hour || c.eligibleLocked(state, candidate, now) != "" {
			delete(state.Candidates, id)
		}
	}
	type retainedCandidate struct {
		id    string
		at    time.Time
		bytes int
	}
	retained := make([]retainedCandidate, 0, len(state.Candidates))
	totalBytes := 0
	for id, candidate := range state.Candidates {
		encoded, _ := json.Marshal(candidate)
		totalBytes += len(encoded)
		retained = append(retained, retainedCandidate{id, candidate.FirstSeenAt, len(encoded)})
	}
	if totalBytes > curatorCandidateBytes {
		state.LastCollection.CandidateByteLimit = true
	}
	sort.Slice(retained, func(i, j int) bool {
		if retained[i].at.Equal(retained[j].at) {
			return retained[i].id < retained[j].id
		}
		return retained[i].at.Before(retained[j].at)
	})
	for _, candidate := range retained {
		if len(state.Candidates) <= curatorCandidateLimit && totalBytes <= curatorCandidateBytes {
			break
		}
		delete(state.Candidates, candidate.id)
		totalBytes -= candidate.bytes
	}
}
