package main

import (
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

const mainBoardSize = 21
const defaultAuthorShare = 20

type CampaignEntry struct {
	LedgerEntry
	Event       *nostr.Event `json:"event"`
	FirstPaidAt int64        `json:"first_paid_at"`
	HotSats     int64        `json:"hot_sats"`
	AuthorShare int          `json:"author_share"`
}

func firstPromotionAt(post *PromotedPost) time.Time {
	if !post.FirstPromotedAt.IsZero() {
		return post.FirstPromotedAt
	}
	// Old files retain the earliest available payment; no data migration is needed.
	first := post.LastPaymentTimestamp
	for _, payment := range post.Payments {
		if first.IsZero() || payment.At.Before(first) {
			first = payment.At
		}
	}
	return first
}

func campaignAuthorShare(post *PromotedPost) int {
	if post != nil {
		if post.AuthorShare != nil {
			return *post.AuthorShare
		}
		// Campaigns created before splits retain their visibility-only default.
		return 0
	}
	return defaultAuthorShare
}

func quoteAuthorShare(quote *nostr.Event) *int {
	if quote == nil {
		return nil
	}
	for _, tag := range quote.Tags {
		if len(tag) >= 4 && tag[0] == "zap" && tag[1] != quote.PubKey {
			share, err := strconv.Atoi(tag[3])
			if err == nil && share >= 0 && share <= 99 {
				return &share
			}
		}
	}
	zero := 0
	return &zero
}

func (s *Storage) CampaignEntries(now time.Time) []CampaignEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	posts := make([]*PromotedPost, 0, len(s.posts))
	for id, post := range s.posts {
		if !s.removed[id] && post.weight(now) > 0 {
			posts = append(posts, post)
		}
	}
	sort.Slice(posts, func(i, j int) bool { return rankLessAt(posts[i], posts[j], now) })
	entries := make([]CampaignEntry, 0, len(posts))
	for i, post := range posts {
		var hot int64
		history := post.Payments
		if len(history) == 0 {
			history = []Payment{{Sats: post.TotalSatsPaid, At: post.LastPaymentTimestamp}}
		}
		for _, payment := range history {
			if !payment.At.Before(now.Add(-24*time.Hour)) && !payment.At.After(now) {
				hot += payment.Sats
			}
		}
		entries = append(entries, CampaignEntry{
			LedgerEntry: LedgerEntry{ID: post.PostID, SatsPaid: post.TotalSatsPaid, Weight: post.weight(now), Rank: i + 1, LastPaidAt: post.LastPaymentTimestamp.Unix(), Billboard: cloneBillboard(post.Billboard)},
			Event:       cloneNostrEvent(post.Event), FirstPaidAt: firstPromotionAt(post).Unix(), HotSats: hot, AuthorShare: campaignAuthorShare(post),
		})
	}
	return entries
}

func waitingEntries(entries []CampaignEntry, view string) []CampaignEntry {
	result := make([]CampaignEntry, 0)
	for _, entry := range entries {
		if entry.Rank > mainBoardSize && (view != "hot" || entry.HotSats > 0) {
			result = append(result, entry)
		}
	}
	if view == "new" || view == "hot" {
		sort.SliceStable(result, func(i, j int) bool {
			if view == "new" {
				return result[i].FirstPaidAt > result[j].FirstPaidAt
			}
			return result[i].HotSats > result[j].HotSats
		})
	}
	return result
}

func CampaignHandler(storage *Storage) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			writeError(w, 405, "use GET")
			return
		}
		view := r.URL.Query().Get("view")
		if view == "" {
			view = "board"
		}
		if view != "board" && view != "top" && view != "new" && view != "hot" {
			writeError(w, 400, "view must be board, top, new or hot")
			return
		}
		page := 1
		if value := r.URL.Query().Get("page"); value != "" {
			var err error
			page, err = strconv.Atoi(value)
			if err != nil || page < 1 || page > 100000 {
				writeError(w, 400, "invalid page")
				return
			}
		}
		all := storage.CampaignEntries(time.Now())
		var total int64
		for _, entry := range all {
			total += entry.SatsPaid
		}
		targets := make([]LedgerEntry, 0)
		for _, entry := range all {
			if entry.Rank <= 3 || entry.Rank == mainBoardSize {
				targets = append(targets, entry.LedgerEntry)
			}
		}
		selected := all
		if view == "board" {
			if len(selected) > mainBoardSize {
				selected = selected[:mainBoardSize]
			}
		} else {
			selected = waitingEntries(all, view)
		}
		count := len(selected)
		start := (page - 1) * mainBoardSize
		if start > count {
			start = count
		}
		end := start + mainBoardSize
		if end > count {
			end = count
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, 200, struct {
			Entries     []CampaignEntry `json:"entries"`
			Targets     []LedgerEntry   `json:"targets"`
			Total       int             `json:"total"`
			ActivePosts int             `json:"active_posts"`
			TotalSats   int64           `json:"total_sats"`
			HasMore     bool            `json:"has_more"`
		}{selected[start:end], targets, count, len(all), total, end < count})
	}
}
