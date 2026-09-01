package main

import (
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
)

// Taking something off the board.
//
// The relay does not care what it ranks, which is the point of it, and that
// stops being tenable the moment somebody pays to promote something the
// operator cannot host. Until this existed there was no answer: DeleteEvent
// refused every request and Storage had no way to drop a post, so the only
// route was editing the data file on the volume by hand and restarting.
//
// This is not moderation and does not try to be. There is no queue, no report
// button and no appeal. It is one operator taking one note down.

type adminRequest struct {
	Note string `json:"note"`
	// Restore lifts an earlier removal instead of performing one, because a
	// removal with no way back is its own kind of hazard.
	Restore bool `json:"restore"`
}

type adminResponse struct {
	NoteID string `json:"note_id"`
	// SatsRemoved is what the note had collected. Nothing is refunded; this is
	// here so the operator sees the size of what they just took down.
	SatsRemoved int64  `json:"sats_removed,omitempty"`
	Status      string `json:"status"`
}

// AdminHandler removes a note from the board, or lifts a removal.
//
// The caller proves themselves with a bearer token rather than a signature. A
// signed nostr command would fit the rest of the system better, but this has to
// work from a phone at the moment it is needed, and a token in a header is
// something an operator can use from anywhere without a signer to hand.
func AdminHandler(storage *Storage, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			writeError(w, http.StatusMethodNotAllowed, "use POST")
			return
		}

		if !bearerMatches(r.Header.Get("Authorization"), token) {
			// Deliberately says nothing about whether the token was close.
			writeError(w, http.StatusUnauthorized, "not authorised")
			return
		}

		var req adminRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "body must be JSON with a note field")
			return
		}

		noteID := normalizeEventID(req.Note)
		if len(noteID) != 64 || !isHex64(noteID) {
			noteID = normalizeEventID(extractEventIDFromText(req.Note))
		}
		if len(noteID) != 64 || !isHex64(noteID) {
			writeError(w, http.StatusBadRequest, "could not find a note reference in that")
			return
		}

		if req.Restore {
			if err := storage.RestorePost(noteID); err != nil {
				writeError(w, http.StatusNotFound, err.Error())
				return
			}
			log.Printf("Admin restored %s", short(noteID, 8))
			writeJSON(w, http.StatusOK, adminResponse{NoteID: noteID, Status: "restored"})
			return
		}

		sats, err := storage.RemovePost(noteID)
		if err != nil {
			log.Printf("Admin failed to remove %s: %v", short(noteID, 8), err)
			writeError(w, http.StatusInternalServerError, "could not write the change")
			return
		}

		log.Printf("Admin removed %s (%d sats)", short(noteID, 8), sats)
		writeJSON(w, http.StatusOK, adminResponse{
			NoteID:      noteID,
			SatsRemoved: sats,
			Status:      "removed",
		})
	}
}

// bearerMatches compares in constant time, so the comparison cannot be used to
// learn the token one byte at a time.
func bearerMatches(header, token string) bool {
	const prefix = "Bearer "
	if token == "" || len(header) <= len(prefix) || header[:len(prefix)] != prefix {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(header[len(prefix):]), []byte(token)) == 1
}
