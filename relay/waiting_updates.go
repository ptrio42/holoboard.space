package main

import (
	"net/http"
	"strconv"
	"time"
)

// WaitingUpdatesHandler counts first promotions across the entire active waiting room.
func WaitingUpdatesHandler(storage *Storage) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			writeError(w, http.StatusMethodNotAllowed, "use GET")
			return
		}
		now := time.Now()
		var since int64
		value := r.URL.Query().Get("since")
		if value != "" {
			var err error
			since, err = strconv.ParseInt(value, 10, 64)
			if err != nil || since < 0 || since > now.UnixMilli() {
				writeError(w, http.StatusBadRequest, "since must be a past Unix timestamp in milliseconds")
				return
			}
		}
		ids := make([]string, 0)
		if value != "" {
			for _, entry := range storage.CampaignEntries(now) {
				if entry.Rank > mainBoardSize && entry.firstPaidAtMillis > since && entry.firstPaidAtMillis <= now.UnixMilli() {
					ids = append(ids, entry.ID)
				}
			}
		}
		writeJSON(w, http.StatusOK, struct {
			Count     int      `json:"count"`
			NoteIDs   []string `json:"note_ids"`
			CheckedAt int64    `json:"checked_at"`
		}{len(ids), ids, now.UnixMilli()})
	}
}
