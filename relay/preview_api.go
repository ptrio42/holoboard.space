package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// PreviewHandler fetches unpaid content into a bounded, short-lived memory
// cache. It never stores an unpaid note on the board or publishes it.
func PreviewHandler(storage *Storage, fetcher *PostFetcher) http.HandlerFunc {
	limiter := newRateLimiter(promoteBurst, promoteWindow)
	type cached struct {
		event   *nostr.Event
		expires time.Time
	}
	cache := make(map[string]cached)
	var mu sync.Mutex
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			writeError(w, http.StatusMethodNotAllowed, "use POST")
			return
		}
		if !limiter.allow(clientAddress(r), time.Now()) {
			writeError(w, http.StatusTooManyRequests, "too many previews requested, try again later")
			return
		}
		var req struct {
			Note string `json:"note"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "body must contain a note reference")
			return
		}
		reference := req.Note
		id := normalizeEventID(reference)
		if !isHex64(id) {
			reference = extractEventIDFromText(reference)
			id = normalizeEventID(reference)
		}
		if !isHex64(id) {
			writeError(w, http.StatusBadRequest, "paste a valid note reference or link")
			return
		}
		if storage.IsRemoved(id) {
			writeError(w, http.StatusConflict, "this note was removed by the operator")
			return
		}
		var event *nostr.Event
		var billboard *BillboardConfig
		active := false
		var sats, weight int64
		var rank int
		if post, known := storage.GetPost(id); known {
			event = post.Event
			weight = post.weight(time.Now())
			active = weight > 0
			sats = post.TotalSatsPaid
			if active {
				billboard = post.Billboard
			}
			for _, entry := range storage.Ledger() {
				if entry.ID == id {
					rank = entry.Rank
					break
				}
			}
		}
		if event == nil {
			mu.Lock()
			hit, ok := cache[id]
			if ok && hit.expires.After(time.Now()) {
				event = hit.event
			}
			mu.Unlock()
		}
		if event == nil {
			ctx, cancel := context.WithTimeout(r.Context(), promoteFetchTimeout)
			defer cancel()
			hints, author := noteHints(reference)
			var err error
			event, err = fetcher.FetchPostFrom(ctx, id, hints, author)
			if err != nil {
				writeError(w, http.StatusNotFound, "could not find that note on any relay this board watches")
				return
			}
			if !isPromotable(event.Kind) {
				writeError(w, http.StatusBadRequest, fmt.Sprintf("kind %d is not a text note or comment", event.Kind))
				return
			}
			mu.Lock()
			for key, value := range cache {
				if !value.expires.After(time.Now()) {
					delete(cache, key)
				}
			}
			if len(cache) >= 128 {
				for key := range cache {
					delete(cache, key)
					break
				}
			}
			cache[id] = cached{event: event, expires: time.Now().Add(time.Minute)}
			mu.Unlock()
		}
		writeJSON(w, http.StatusOK, struct {
			Event     *nostr.Event     `json:"event"`
			Active    bool             `json:"active"`
			Sats      int64            `json:"sats_paid"`
			Weight    int64            `json:"weight"`
			Rank      int              `json:"rank"`
			Billboard *BillboardConfig `json:"billboard,omitempty"`
			Fee       int64            `json:"billboard_fee_sats"`
			Images    []string         `json:"images"`
		}{event, active, sats, weight, rank, billboard, billboardFeeSats, billboardImages(event.Content)})
	}
}
