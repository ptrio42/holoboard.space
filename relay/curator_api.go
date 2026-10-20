package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

type curatorPolicy struct {
	DailyDiscoveries   int      `json:"daily_discoveries"`
	DailyRewardSats    int64    `json:"daily_reward_sats"`
	RewardTiers        []int64  `json:"reward_tiers"`
	PlacementDays      int      `json:"placement_days"`
	AuthorCooldownDays int      `json:"author_cooldown_days"`
	BitcoinNostrWindow int      `json:"bitcoin_nostr_window"`
	MinimumConfidence  float64  `json:"minimum_confidence"`
	Topics             []string `json:"topics"`
	ModelRoundsPerDay  int      `json:"model_rounds_per_day"`
	ReviewRequired     bool     `json:"review_required"`
}

func policyFor(state *curatorState) curatorPolicy {
	return curatorPolicy{state.DailyDiscoveries, state.DailyRewardSats, []int64{21, 100, 500}, 7, 30, 5, 0.7, []string{"arts", "science", "culture", "practical", "community", "projects", "personal", "bitcoin_nostr", "other"}, 2, curatorReviewRequired(state)}
}

func (c *CuratorService) authorised(w http.ResponseWriter, r *http.Request, method, token string) bool {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != method {
		w.Header().Set("Allow", method)
		writeError(w, 405, "use "+method)
		return false
	}
	if !bearerMatches(r.Header.Get("Authorization"), token) {
		writeError(w, 401, "not authorised")
		return false
	}
	if c.initErr != nil {
		writeError(w, 503, "curator storage unavailable")
		return false
	}
	return true
}

func decodeCuratorRequest(w http.ResponseWriter, r *http.Request, into any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		writeError(w, 400, "invalid JSON request")
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		writeError(w, 400, "request must contain one JSON object")
		return false
	}
	return true
}

func (c *CuratorService) CandidatesHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !c.authorised(w, r, http.MethodGet, c.config.Token) {
			return
		}
		now := c.now().UTC()
		c.storage.mu.Lock()
		defer c.storage.mu.Unlock()
		before := c.storage.curator
		state := cloneCuratorState(before)
		if state.Mode == curatorDisabled || (state.Mode == curatorActive && !curatorIsActive(state, now)) {
			writeError(w, 409, "curator is disabled or pilot expired")
			return
		}
		c.pruneLocked(state, now)
		slot := fmt.Sprintf("%s-%d", curatorDay(now), now.Hour()/12)
		batch := state.Batches[slot]
		if batch == nil || (!batch.Completed && len(batch.Candidates) == 0) {
			candidates := []*CuratorCandidate{}
			for id, candidate := range state.Candidates {
				if _, rejected := state.Rejected[id]; !rejected {
					candidates = append(candidates, candidate)
				}
			}
			digest := sha256.Sum256([]byte(slot + state.DryRunStartedAt.String() + state.ActiveStartedAt.String()))
			batch = &curatorBatch{ID: hex.EncodeToString(digest[:]), Slot: slot, CreatedAt: now, Candidates: map[string]*CuratorCandidate{}}
			for _, candidate := range sampleCuratorCandidates(candidates, batch.ID, curatorBatchLimit) {
				batch.Candidates[candidate.Event.ID.Hex()] = candidate
			}
			state.Batches[slot] = batch
		}
		c.storage.curator = state
		if err := c.storage.save(); err != nil {
			c.storage.curator = before
			writeError(w, 500, "could not persist issued batch")
			return
		}
		candidates := []*CuratorCandidate{}
		if !batch.Completed {
			for _, candidate := range batch.Candidates {
				candidates = append(candidates, candidate)
			}
		}
		sort.Slice(candidates, func(i, j int) bool { return candidates[i].Event.ID.Hex() < candidates[j].Event.ID.Hex() })
		recent := []*Discovery{}
		for _, d := range curatorHistory(state) {
			if !d.CreatedAt.Before(now.Add(-30 * 24 * time.Hour)) {
				recent = append(recent, d)
			}
		}
		writeJSON(w, 200, struct {
			BatchID          string                  `json:"batch_id"`
			Candidates       []*CuratorCandidate     `json:"candidates"`
			Policy           curatorPolicy           `json:"policy"`
			RecentSelections []curatorSelection      `json:"recent_selections"`
			Mode             string                  `json:"mode"`
			Completed        bool                    `json:"completed"`
			Collection       curatorCollectionStatus `json:"collection"`
		}{batch.ID, candidates, policyFor(state), selectionSummaries(recent), state.Mode, batch.Completed, state.LastCollection})
	}
}

type curatorSelection struct {
	NoteID    string    `json:"note_id"`
	Author    string    `json:"author"`
	Topic     string    `json:"topic"`
	Language  string    `json:"language"`
	CreatedAt time.Time `json:"created_at"`
}

func selectionSummaries(discoveries []*Discovery) []curatorSelection {
	result := []curatorSelection{}
	for _, d := range discoveries {
		result = append(result, curatorSelection{d.NoteID, d.Event.PubKey.Hex(), d.Topic, d.Language, d.CreatedAt})
	}
	return result
}

func (c *CuratorService) DecisionsHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !c.authorised(w, r, http.MethodPost, c.config.Token) {
			return
		}
		var request curatorDecisionRequest
		if !decodeCuratorRequest(w, r, &request) {
			return
		}
		if strings.TrimSpace(request.RunID) == "" || len(request.RunID) > 128 || request.BatchID == "" || len(request.Decisions) > 50 || len(request.Decisions) == 0 {
			writeError(w, 400, "run_id, batch_id and 1 to 50 decisions required")
			return
		}
		now := c.now().UTC()
		requestJSON, _ := json.Marshal(request)
		requestHash := sha256.Sum256(requestJSON)
		requestDigest := hex.EncodeToString(requestHash[:])
		c.storage.mu.Lock()
		defer c.storage.mu.Unlock()
		before := c.storage.curator
		if run := before.Runs[request.RunID]; run != nil {
			if run.RequestDigest != requestDigest {
				writeError(w, 409, "run_id already used with different content")
				return
			}
			writeJSON(w, 200, run.Result)
			return
		}
		if len(before.Runs) >= curatorRunLimit {
			writeError(w, 409, "pilot run journal is full; previous runs remain available for replay")
			return
		}
		state := cloneCuratorState(before)
		if state.Mode == curatorDisabled || (state.Mode == curatorActive && !curatorIsActive(state, now)) {
			writeError(w, 409, "curator is disabled or pilot expired")
			return
		}
		var batch *curatorBatch
		for _, issued := range state.Batches {
			if issued.ID == request.BatchID {
				batch = issued
				break
			}
		}
		if batch == nil || now.Sub(batch.CreatedAt) >= curatorBatchTTL {
			writeError(w, 410, "batch is absent or expired")
			return
		}
		if batch.Completed {
			writeError(w, 409, "batch already completed")
			return
		}
		seen := map[string]bool{}
		for _, decision := range request.Decisions {
			if batch.Candidates[decision.NoteID] == nil || seen[decision.NoteID] {
				writeError(w, 400, "decision must reference a distinct candidate from this batch")
				return
			}
			seen[decision.NoteID] = true
		}
		result := curatorDecisionResult{RunID: request.RunID, Mode: state.Mode, Published: []string{}, Proposed: []string{}, Rejected: []curatorRejection{}}
		for _, decision := range request.Decisions {
			candidate := batch.Candidates[decision.NoteID]
			reason := "not selected"
			if decision.Selected {
				reason = c.eligibleLocked(state, candidate, now)
				if reason == "" {
					reason = curatorPolicyError(state, candidate, decision, now)
				}
				if reason == "" && state.Mode == curatorActive && curatorReviewRequired(state) && len(state.PendingReviews) >= curatorReviewLimit {
					reason = "review queue is full"
				}
			}
			if reason != "" {
				result.Rejected = append(result.Rejected, curatorRejection{decision.NoteID, reason})
				state.Rejected[decision.NoteID] = now
				delete(state.Candidates, decision.NoteID)
				continue
			}
			d := &Discovery{NoteID: decision.NoteID, Event: cloneNostrEvent(candidate.Event), Reason: strings.TrimSpace(decision.Reason), Topic: decision.Topic, Language: decision.Language, Confidence: decision.Confidence, CreatedAt: now, ExpiresAt: now.Add(curatorPlacement), SourceRelays: append([]string(nil), candidate.SourceRelays...), Reward: DiscoveryReward{Status: "pending", AmountSats: decision.RewardSats}}
			reviewDigest := sha256.Sum256([]byte(request.RunID + ":" + d.NoteID))
			d.ReviewID = hex.EncodeToString(reviewDigest[:])
			state.NextSequence++
			d.Sequence = state.NextSequence
			if state.Mode == curatorDryRun {
				d.Reward.Status = "dry_run"
				d.ReviewStatus = "pending"
				state.Proposals = append(state.Proposals, d)
				result.Proposed = append(result.Proposed, d.NoteID)
			} else if curatorReviewRequired(state) {
				d.Reward.Status, d.ReviewStatus = "awaiting_review", "pending"
				state.PendingReviews[d.NoteID] = d
				result.Proposed = append(result.Proposed, d.NoteID)
			} else {
				d.ReviewStatus = "automatic"
				state.Discoveries[d.NoteID] = d
				result.Published = append(result.Published, d.NoteID)
			}
			delete(state.Candidates, d.NoteID)
		}
		batch.Completed = true
		if state.Mode == curatorDryRun {
			state.DryRunDays[curatorDay(now)] = true
		}
		state.Runs[request.RunID] = &curatorRun{RequestDigest: requestDigest, Result: result, CreatedAt: now}
		c.pruneLocked(state, now)
		c.storage.curator = state
		if err := c.storage.save(); err != nil {
			c.storage.curator = before
			writeError(w, 500, "could not persist decisions")
			return
		}
		writeJSON(w, 200, result)
	}
}

func (c *CuratorService) StatusHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !c.authorised(w, r, http.MethodGet, c.config.Token) {
			return
		}
		c.storage.mu.RLock()
		defer c.storage.mu.RUnlock()
		s := c.storage.curator
		// Private review output excludes all invoice and wallet journal fields.
		proposals := make([]map[string]any, 0, min(21, len(s.Proposals)))
		for index := len(s.Proposals) - 1; index >= 0 && len(proposals) < 21; index-- {
			d := s.Proposals[index]
			proposals = append(proposals, map[string]any{"note_id": d.NoteID, "event": cloneNostrEvent(d.Event), "reason": d.Reason,
				"topic": d.Topic, "language": d.Language, "confidence": d.Confidence, "reward_sats": d.Reward.AmountSats, "created_at": d.CreatedAt})
		}
		writeJSON(w, 200, struct {
			Mode                string                  `json:"mode"`
			DryRunStartedAt     time.Time               `json:"dry_run_started_at"`
			DryRunCompletedDays int                     `json:"dry_run_completed_days"`
			ActiveStartedAt     time.Time               `json:"active_started_at"`
			PilotDeadline       time.Time               `json:"pilot_deadline"`
			SpendingAllowed     bool                    `json:"spending_allowed"`
			ReservedSats        int64                   `json:"reserved_sats"`
			Discoveries         int                     `json:"discoveries"`
			Proposals           int                     `json:"proposals"`
			Candidates          int                     `json:"candidates"`
			LastCollectedAt     time.Time               `json:"last_collected_at"`
			Collection          curatorCollectionStatus `json:"collection"`
			RunJournalCapacity  int                     `json:"run_journal_capacity"`
			RecordedRuns        int                     `json:"recorded_runs"`
			Policy              curatorPolicy           `json:"policy"`
			RecentProposals     []map[string]any        `json:"recent_proposals"`
			ReviewRequired      bool                    `json:"review_required"`
			PendingReviews      int                     `json:"pending_reviews"`
		}{s.Mode, s.DryRunStartedAt, len(s.DryRunDays), s.ActiveStartedAt, s.PilotDeadline, curatorIsActive(s, c.now()), curatorReserved(s, c.now()), len(s.Discoveries), len(s.Proposals), len(s.Candidates), s.LastCollectedAt, s.LastCollection, curatorRunLimit, len(s.Runs), policyFor(s), proposals, curatorReviewRequired(s), len(curatorReviewItems(s, c.now()))})
	}
}

func (c *CuratorService) AdminHandler(adminToken string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !c.authorised(w, r, http.MethodPost, adminToken) {
			return
		}
		var request struct {
			Mode string `json:"mode"`
		}
		if !decodeCuratorRequest(w, r, &request) {
			return
		}
		if request.Mode != curatorDisabled && request.Mode != curatorDryRun && request.Mode != curatorActive {
			writeError(w, 400, "invalid curator mode")
			return
		}
		now := c.now().UTC()
		c.storage.mu.Lock()
		defer c.storage.mu.Unlock()
		before := c.storage.curator
		state := cloneCuratorState(before)
		if request.Mode == curatorActive {
			if c.activationCheck != nil {
				if err := c.activationCheck(); err != nil {
					writeError(w, 409, err.Error())
					return
				}
			}
			if state.ActiveStartedAt.IsZero() && (state.DryRunStartedAt.IsZero() || now.Sub(state.DryRunStartedAt) < 7*24*time.Hour || len(state.DryRunDays) < 7) {
				writeError(w, 409, "activation requires seven elapsed days and completed decisions on seven UTC dry-run days")
				return
			}
			if !state.PilotDeadline.IsZero() && !now.Before(state.PilotDeadline) {
				writeError(w, 409, "pilot deadline has passed")
				return
			}
			if state.ActiveStartedAt.IsZero() {
				state.ActiveStartedAt = now
				state.PilotDeadline = now.Add(30 * 24 * time.Hour)
			}
		}
		if request.Mode == curatorDryRun && state.DryRunStartedAt.IsZero() {
			state.DryRunStartedAt = now
		}
		state.Mode = request.Mode
		c.storage.curator = state
		if err := c.storage.save(); err != nil {
			c.storage.curator = before
			writeError(w, 500, "could not persist mode")
			return
		}
		writeJSON(w, 200, map[string]any{"mode": state.Mode, "dry_run_started_at": state.DryRunStartedAt, "active_started_at": state.ActiveStartedAt, "pilot_deadline": state.PilotDeadline})
	}
}
