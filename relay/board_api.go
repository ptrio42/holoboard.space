package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"
)

// boardResponse is the payload of GET /api/board.
type boardResponse struct {
	Entries   []LedgerEntry `json:"entries"`
	Posts     int           `json:"posts"`
	TotalSats int64         `json:"total_sats"`
	UpdatedAt int64         `json:"updated_at"`
}

// BoardHandler serves the payment ledger: what every promoted note has been
// paid, in the same order the relay serves the notes themselves.
//
// This exists because a nostr event is signed over its own tags, so the relay
// cannot annotate a stored note with its sats total without invalidating the
// signature and having every client drop it. The board's entire premise is
// "rank is total sats", and until this endpoint existed no client could see the
// figure that premise rests on.
//
// The tradeoff being made: a generic nostr client still sees only an
// unexplained order, and a client reading this has to poll, because the ledger
// travels outside the subscription that carries the notes. A relay-signed
// companion event would fix both, at the cost of a custom event kind and
// broadcast plumbing khatru is not currently wired for.
func BoardHandler(storage *Storage) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		entries := storage.Ledger()

		var total int64
		for _, entry := range entries {
			total += entry.SatsPaid
		}

		body, err := json.Marshal(boardResponse{
			Entries:   entries,
			Posts:     len(entries),
			TotalSats: total,
			UpdatedAt: time.Now().Unix(),
		})
		if err != nil {
			log.Printf("Failed to marshal board ledger: %v", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		// Short cache: the figure changes only when someone pays, and a client
		// polling every few seconds should not be re-reading the same bytes.
		w.Header().Set("Cache-Control", "public, max-age=5")

		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		if _, err := w.Write(body); err != nil {
			log.Printf("Failed to write board ledger: %v", err)
		}
	}
}
