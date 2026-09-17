package main

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

type expiredCursor struct {
	paidAt time.Time
	id     string
}

type expiredEntry struct {
	Event      *nostr.Event `json:"event"`
	SatsPaid   int64        `json:"sats_paid"`
	LastPaidAt int64        `json:"last_paid_at"`
}

type expiredResponse struct {
	Entries    []expiredEntry `json:"entries"`
	NextCursor string         `json:"next_cursor,omitempty"`
}

// Copy a page under the storage lock. Payment updates can remove notes from
// the archive, so pagination uses a timestamp and ID rather than an offset.
func (s *Storage) expiredPosts(now time.Time, limit int, before *expiredCursor) []PromotedPost {
	s.mu.RLock()
	defer s.mu.RUnlock()
	posts := make([]PromotedPost, 0)
	for _, post := range s.posts {
		if post.weight(now) > 0 || s.removed[post.PostID] {
			continue
		}
		if before != nil {
			paidAt := post.LastPaymentTimestamp
			if paidAt.After(before.paidAt) || (paidAt.Equal(before.paidAt) && post.PostID <= before.id) {
				continue
			}
		}
		posts = append(posts, *post)
	}
	sort.Slice(posts, func(i, j int) bool {
		if posts[i].LastPaymentTimestamp.Equal(posts[j].LastPaymentTimestamp) {
			return posts[i].PostID < posts[j].PostID
		}
		return posts[i].LastPaymentTimestamp.After(posts[j].LastPaymentTimestamp)
	})
	if len(posts) > limit {
		posts = posts[:limit]
	}
	return posts
}

func ExpiredHandler(storage *Storage) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			writeError(w, http.StatusMethodNotAllowed, "use GET")
			return
		}
		limit := 20
		if value := r.URL.Query().Get("limit"); value != "" {
			var err error
			limit, err = strconv.Atoi(value)
			if err != nil || limit < 1 || limit > 50 {
				writeError(w, http.StatusBadRequest, "limit must be between 1 and 50")
				return
			}
		}
		var cursor *expiredCursor
		if value := r.URL.Query().Get("cursor"); value != "" {
			if len(value) > 256 {
				writeError(w, http.StatusBadRequest, "invalid cursor")
				return
			}
			raw, err := base64.RawURLEncoding.DecodeString(value)
			parts := strings.SplitN(string(raw), "|", 2)
			if err != nil || len(parts) != 2 || !isHex64(parts[1]) {
				writeError(w, http.StatusBadRequest, "invalid cursor")
				return
			}
			paidAt, err := time.Parse(time.RFC3339Nano, parts[0])
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid cursor")
				return
			}
			cursor = &expiredCursor{paidAt: paidAt, id: parts[1]}
		}
		posts := storage.expiredPosts(time.Now(), limit+1, cursor)
		response := expiredResponse{Entries: make([]expiredEntry, 0, limit)}
		if len(posts) > limit {
			posts = posts[:limit]
			last := posts[len(posts)-1]
			response.NextCursor = base64.RawURLEncoding.EncodeToString([]byte(
				fmt.Sprintf("%s|%s", last.LastPaymentTimestamp.Format(time.RFC3339Nano), last.PostID)))
		}
		for _, post := range posts {
			response.Entries = append(response.Entries, expiredEntry{
				Event: post.Event, SatsPaid: post.TotalSatsPaid, LastPaidAt: post.LastPaymentTimestamp.Unix(),
			})
		}
		w.Header().Set("Cache-Control", "no-store")
		if r.Method == http.MethodHead {
			w.Header().Set("Content-Type", "application/json")
			return
		}
		writeJSON(w, http.StatusOK, response)
	}
}
