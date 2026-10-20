package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"time"
)

type curatorReviewItem struct {
	NoteID    string     `json:"note_id"`
	Discovery *Discovery `json:"-"`
	DryRun    bool       `json:"dry_run"`
	Published bool       `json:"published"`
}

func curatorReviewItems(state *curatorState, now time.Time) []curatorReviewItem {
	items := []curatorReviewItem{}
	for _, d := range state.Proposals {
		if (d.ReviewStatus == "" || d.ReviewStatus == "pending") && d.ExpiresAt.After(now) {
			items = append(items, curatorReviewItem{d.NoteID, d, true, false})
		}
	}
	for _, d := range state.PendingReviews {
		if d.ReviewStatus == "pending" && d.ExpiresAt.After(now) {
			items = append(items, curatorReviewItem{d.NoteID, d, false, false})
		}
	}
	if curatorReviewRequired(state) {
		for _, d := range state.Discoveries {
			if d.ReviewStatus != "approved" && unattemptedReviewReward(d) && d.ExpiresAt.After(now) {
				items = append(items, curatorReviewItem{d.NoteID, d, false, true})
			}
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Discovery.CreatedAt.Equal(items[j].Discovery.CreatedAt) {
			return items[i].NoteID < items[j].NoteID
		}
		return items[i].Discovery.CreatedAt.After(items[j].Discovery.CreatedAt)
	})
	return items
}

func unattemptedReviewReward(d *Discovery) bool {
	return (d.Reward.Status == "pending" || d.Reward.Status == "preparing") &&
		d.Reward.PaymentHash == "" && d.Reward.AttemptedAt.IsZero()
}

type curatorReviewRequest struct {
	Action         string `json:"action"`
	NoteID         string `json:"note_id,omitempty"`
	ReviewID       string `json:"review_id,omitempty"`
	RewardSats     int64  `json:"reward_sats,omitempty"`
	ReviewRequired *bool  `json:"review_required,omitempty"`
}

func curatorReviewID(d *Discovery) string {
	if d.ReviewID != "" {
		return d.ReviewID
	}
	digest := sha256.Sum256([]byte(fmt.Sprintf("%s:%s:%d:%s", d.NoteID, d.CreatedAt.UTC().Format(time.RFC3339Nano), d.Reward.AmountSats, d.Reward.Status)))
	return hex.EncodeToString(digest[:])
}

// The reviewer credential cannot activate the fund or remove unrelated notes.
// The agent credential cannot read this queue, approve notes or change review.
func (c *CuratorService) ReviewHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			w.Header().Set("Allow", "GET, POST")
			writeError(w, 405, "use GET or POST")
			return
		}
		if c.config.ReviewToken == "" || !c.authorised(w, r, r.Method, c.config.ReviewToken) {
			if c.config.ReviewToken == "" {
				writeError(w, 401, "reviewer is not configured")
			}
			return
		}
		if r.Method == http.MethodGet {
			c.reviewSnapshot(w, r)
			return
		}
		var request curatorReviewRequest
		if !decodeCuratorRequest(w, r, &request) {
			return
		}
		if request.Action == "set_review" {
			if request.ReviewRequired == nil || request.NoteID != "" || request.ReviewID != "" || request.RewardSats != 0 {
				writeError(w, 400, "review_required is required for set_review")
				return
			}
		} else if (request.Action != "approve" && request.Action != "reject") || !isHex64(request.NoteID) || !isHex64(request.ReviewID) || request.ReviewRequired != nil ||
			(request.Action == "reject" && request.RewardSats != 0) {
			writeError(w, 400, "use approve or reject with a note_id")
			return
		}
		now := c.now().UTC()
		c.storage.mu.Lock()
		defer c.storage.mu.Unlock()
		before := c.storage.curator
		state := cloneCuratorState(before)
		var result map[string]any
		if request.Action == "set_review" {
			state.ReviewRequired = request.ReviewRequired
			result = map[string]any{"review_required": *state.ReviewRequired, "mode": state.Mode}
		} else {
			var code int
			var err error
			result, code, err = c.reviewDecision(state, request, now)
			if err != nil {
				writeError(w, code, err.Error())
				return
			}
		}
		c.storage.curator = state
		if err := c.storage.save(); err != nil {
			c.storage.curator = before
			writeError(w, 500, "could not persist review")
			return
		}
		writeJSON(w, 200, result)
	}
}

func (c *CuratorService) reviewSnapshot(w http.ResponseWriter, r *http.Request) {
	offset, err := strconv.Atoi(r.URL.Query().Get("offset"))
	if r.URL.Query().Get("offset") == "" {
		offset, err = 0, nil
	}
	if err != nil || offset < 0 {
		writeError(w, 400, "invalid offset")
		return
	}
	c.storage.mu.RLock()
	defer c.storage.mu.RUnlock()
	state := c.storage.curator
	items := curatorReviewItems(state, c.now())
	rows := []map[string]any{}
	start := min(offset, len(items))
	end := start + min(21, len(items)-start)
	for _, item := range items[start:end] {
		d := item.Discovery
		rows = append(rows, map[string]any{"note_id": d.NoteID, "review_id": curatorReviewID(d), "event": cloneNostrEvent(d.Event), "reason": d.Reason,
			"topic": d.Topic, "language": d.Language, "confidence": d.Confidence, "reward_sats": d.Reward.AmountSats,
			"created_at": d.CreatedAt, "expires_at": d.ExpiresAt, "dry_run": item.DryRun, "published": item.Published})
	}
	writeJSON(w, 200, map[string]any{"mode": state.Mode, "review_required": curatorReviewRequired(state),
		"spending_allowed":  !c.storage.curatorUnavailable && curatorIsActive(state, c.now()),
		"daily_reward_sats": state.DailyRewardSats, "daily_discoveries": state.DailyDiscoveries,
		"pending_count": len(items), "offset": offset, "items": rows})
}

func (c *CuratorService) reviewDecision(state *curatorState, request curatorReviewRequest, now time.Time) (map[string]any, int, error) {
	id := request.NoteID
	var d *Discovery
	dryRun, published := false, false
	if pending := state.PendingReviews[id]; pending != nil && curatorReviewID(pending) == request.ReviewID {
		d = pending
	}
	if existing := state.Discoveries[id]; d == nil && existing != nil && curatorReviewID(existing) == request.ReviewID {
		d, published = existing, true
	}
	if d == nil {
		for _, proposal := range state.Proposals {
			if proposal.NoteID == id && curatorReviewID(proposal) == request.ReviewID {
				d, dryRun = proposal, true
				break
			}
		}
	}
	if d == nil {
		return nil, 409, fmt.Errorf("unknown or stale review item")
	}
	result := func() map[string]any {
		return map[string]any{"note_id": id, "review_status": d.ReviewStatus, "reward_sats": d.Reward.AmountSats,
			"dry_run": dryRun, "published": published}
	}
	if request.Action == "approve" && request.RewardSats != d.Reward.AmountSats {
		return nil, 409, fmt.Errorf("approval must match the proposed reward")
	}
	if (request.Action == "approve" && d.ReviewStatus == "approved") || (request.Action == "reject" && d.ReviewStatus == "rejected") {
		return result(), 200, nil
	}
	if d.ReviewStatus == "approved" || d.ReviewStatus == "rejected" || d.ReviewStatus == "expired" || !d.ExpiresAt.After(now) {
		return nil, 409, fmt.Errorf("item was already reviewed or expired")
	}
	if published && (!curatorReviewRequired(state) || !unattemptedReviewReward(d)) {
		return nil, 409, fmt.Errorf("reward is automatic or has already been attempted")
	}
	if request.Action == "reject" {
		d.ReviewID = request.ReviewID
		d.ReviewStatus, d.ReviewedAt = "rejected", now
		if !dryRun {
			d.Reward.Status = "rejected"
		}
		state.Rejected[id] = now
		return result(), 200, nil
	}
	if !dryRun {
		if !curatorIsActive(state, now) || c.storage.removed[id] {
			return nil, 409, fmt.Errorf("fund is paused, expired or note was removed")
		}
		if published && curatorReserved(state, now) > state.DailyRewardSats {
			return nil, 409, fmt.Errorf("current reward budget is below existing reservations")
		}
		if !published {
			// Approval is a fresh admission. Recheck current limits, author cooldown
			// and signed originals without counting the proposal against itself.
			delete(state.PendingReviews, id)
			candidate := &CuratorCandidate{Event: d.Event, SourceRelays: d.SourceRelays, FirstSeenAt: d.CreatedAt}
			choice := CuratorDecision{id, true, d.Reason, d.Topic, d.Language, d.Confidence, d.Reward.AmountSats}
			if reason := c.eligibleLocked(state, candidate, now); reason != "" {
				return nil, 409, fmt.Errorf("cannot approve: %s", reason)
			}
			if reason := curatorPolicyError(state, candidate, choice, now); reason != "" {
				return nil, 409, fmt.Errorf("cannot approve: %s", reason)
			}
			state.NextSequence++
			d.ReviewID = request.ReviewID
			d.Sequence, d.CreatedAt, d.ExpiresAt = state.NextSequence, now, now.Add(curatorPlacement)
			d.Reward.Status = "pending"
			state.Discoveries[id], published = d, true
		}
	}
	d.ReviewID, d.ReviewStatus, d.ReviewedAt = request.ReviewID, "approved", now
	return result(), 200, nil
}
