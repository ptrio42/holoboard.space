package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"time"
)

// Promoting a note does not need an identity. The relay never checks who
// mentioned it, and crediting comes from the payment rather than from whoever
// asked, so requiring a NIP-07 signer on the website was an artefact of
// implementing the web flow as "automate the mention flow" rather than "ask for
// an invoice". This endpoint is the version with no login: hand it a note, get
// a bolt11, pay it.
//
// It is also the only way the invoice settlement path gets real users. Every
// piece of it works in isolation and the whole chain has never run for anybody.

const (
	// promoteMinSats keeps the wallet from minting invoices nobody would pay.
	promoteMinSats = 1
	// promoteMaxSats is a sanity bound, not a policy. Nothing stops somebody
	// paying more by promoting twice.
	promoteMaxSats = 10_000_000

	// promoteMaxPending caps how many invoices can be outstanding at once
	// across everybody. Each one is a row the reconciler asks the wallet about
	// on every pass, so an unbounded number is a self inflicted load problem.
	promoteMaxPending = 200

	// One address gets promoteBurst requests, refilling over promoteWindow.
	// Generous on purpose: the limit is here to stop somebody minting invoices
	// in a loop, and five was tight enough to catch people simply trying a few
	// amounts. Only requests that actually reach the wallet count against it.
	promoteBurst  = 20
	promoteWindow = 10 * time.Minute

	// The relays are asked all at once, so this is a bound on the whole search
	// rather than on each hop, and it has to leave room for the second pass
	// that asks the author's own relays when the first finds nothing.
	promoteFetchTimeout = 15 * time.Second

	// Bounds the wallet call. Without it a slow wallet races the server's write
	// timeout, and losing that race looks like a 502 with no explanation rather
	// than an error the caller can read.
	promoteMintTimeout = 20 * time.Second

	// Bounds the wallet check the status endpoint triggers. It is on the path of
	// a request a browser is waiting on, so it cannot take as long as minting.
	promoteStatusCheckTimeout = 8 * time.Second
)

type promoteRequest struct {
	Note       string `json:"note"`
	AmountSats int64  `json:"amount_sats"`
}

type promoteResponse struct {
	Invoice     string `json:"invoice"`
	PaymentHash string `json:"payment_hash"`
	AmountSats  int64  `json:"amount_sats"`
	NoteID      string `json:"note_id"`
	ExpiresAt   int64  `json:"expires_at"`
}

type promoteStatus struct {
	// Pending is the only thing this endpoint can state as fact: whether the
	// invoice is still outstanding.
	Pending bool `json:"pending"`
	// SatsPaid is what the note has collected right now. A caller that noted
	// the figure before paying can tell settlement from expiry by comparing,
	// which is something the relay genuinely cannot do on its own: a settled
	// invoice and an expired one are both simply gone.
	SatsPaid int64  `json:"sats_paid"`
	NoteID   string `json:"note_id"`
}

// rateLimiter is a small per-address sliding window. In memory on purpose: this
// relay is one machine by design, and a limit that resets on deploy is still a
// limit against the thing it guards, which is somebody looping the endpoint.
type rateLimiter struct {
	mu      sync.Mutex
	hits    map[string][]time.Time
	burst   int
	window  time.Duration
	lastGC  time.Time
	gcEvery time.Duration
}

func newRateLimiter(burst int, window time.Duration) *rateLimiter {
	return &rateLimiter{
		hits:    make(map[string][]time.Time),
		burst:   burst,
		window:  window,
		gcEvery: window,
	}
}

func (rl *rateLimiter) allow(key string, now time.Time) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	cutoff := now.Add(-rl.window)

	// Drop everyone's stale entries occasionally, so the map does not grow with
	// every address that ever called.
	if now.Sub(rl.lastGC) > rl.gcEvery {
		for addr, times := range rl.hits {
			kept := times[:0]
			for _, t := range times {
				if t.After(cutoff) {
					kept = append(kept, t)
				}
			}
			if len(kept) == 0 {
				delete(rl.hits, addr)
			} else {
				rl.hits[addr] = kept
			}
		}
		rl.lastGC = now
	}

	kept := rl.hits[key][:0]
	for _, t := range rl.hits[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= rl.burst {
		rl.hits[key] = kept
		return false
	}

	rl.hits[key] = append(kept, now)
	return true
}

// clientAddress is who to rate limit. Behind Fly the socket address is the
// proxy, so the real caller is in Fly-Client-IP; falling back to the socket
// keeps this correct when running locally.
func clientAddress(r *http.Request) string {
	if ip := r.Header.Get("Fly-Client-IP"); ip != "" {
		return ip
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("Failed to write response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// PromoteHandler mints an invoice for promoting a note, with no identity
// required from the caller.
func PromoteHandler(storage *Storage, invoices *InvoiceManager, fetcher *PostFetcher) http.HandlerFunc {
	limiter := newRateLimiter(promoteBurst, promoteWindow)

	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			writeError(w, http.StatusMethodNotAllowed, "use POST")
			return
		}

		var req promoteRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "body must be JSON with a note field")
			return
		}

		// Take the reference out of whatever was pasted. People copy the link
		// from njump rather than the bare id, and a URL is a perfectly clear
		// way of saying which note you mean.
		noteID := normalizeEventID(req.Note)
		if len(noteID) != 64 || !isHex64(noteID) {
			noteID = normalizeEventID(extractEventIDFromText(req.Note))
		}
		if len(noteID) != 64 || !isHex64(noteID) {
			writeError(w, http.StatusBadRequest,
				"could not find a note reference in that. Paste a note1, nevent1, "+
					"a 64 character id, or a link containing one.")
			return
		}

		// Read once, used twice: to find the note now, and to find it again
		// when the invoice settles.
		hints, author := noteHints(req.Note)
		if len(hints) == 0 && author == "" {
			hints, author = noteHints(extractEventIDFromText(req.Note))
		}

		amount := req.AmountSats
		if amount == 0 {
			amount = invoices.defaultAmountSats
		}
		if amount < promoteMinSats || amount > promoteMaxSats {
			writeError(w, http.StatusBadRequest,
				fmt.Sprintf("amount must be between %d and %d sats", promoteMinSats, promoteMaxSats))
			return
		}

		if pending := len(storage.ListPendingInvoices()); pending >= promoteMaxPending {
			log.Printf("Refusing to mint an invoice: %d already pending", pending)
			writeError(w, http.StatusServiceUnavailable,
				"too many invoices are waiting to be paid, try again later")
			return
		}

		// Refuse to mint an invoice for a note nobody can find. This is the
		// cheapest abuse guard there is, and it also stops somebody paying for
		// a promotion that could never be fulfilled.
		if _, known := storage.GetPost(noteID); !known {
			ctx, cancel := context.WithTimeout(r.Context(), promoteFetchTimeout)
			defer cancel()

			// An nevent names relays and an author precisely so a reader does
			// not have to already know where the note lives.
			note, err := fetcher.FetchPostFrom(ctx, noteID, hints, author)
			if err != nil {
				writeError(w, http.StatusNotFound,
					"could not find that note on any relay this board watches")
				return
			}
			if !isPromotable(note.Kind) {
				writeError(w, http.StatusBadRequest, fmt.Sprintf(
					"that is a kind %d event, and this board takes text notes and comments",
					note.Kind))
				return
			}
		}

		// The limit is checked here rather than at the top, so a mistyped
		// reference costs nothing. It guards the wallet against somebody
		// minting invoices in a loop, and a request that never reaches the
		// wallet is not what it is for. Getting the format wrong three times
		// should not use up your quota.
		if !limiter.allow(clientAddress(r), time.Now()) {
			writeError(w, http.StatusTooManyRequests,
				"too many invoices requested, try again in a few minutes")
			return
		}

		mintCtx, cancelMint := context.WithTimeout(r.Context(), promoteMintTimeout)
		defer cancelMint()

		invoice, err := invoices.GeneratePromotionInvoice(mintCtx, noteID, amount, hints, author)
		if err != nil {
			log.Printf("Failed to mint a promotion invoice for %s: %v", short(noteID, 8), err)
			writeError(w, http.StatusBadGateway, "the wallet would not issue an invoice")
			return
		}

		log.Printf("Minted a no-login invoice for %s: %d sats", short(noteID, 8), invoice.AmountSats)

		writeJSON(w, http.StatusOK, promoteResponse{
			Invoice:     invoice.PaymentRequest,
			PaymentHash: invoice.PaymentHash,
			AmountSats:  invoice.AmountSats,
			NoteID:      noteID,
			ExpiresAt:   invoice.ExpiresAt.Unix(),
		})
	}
}

// PromoteStatusHandler reports whether an invoice is still outstanding, and
// what the note has collected, so a page showing a QR code knows when to stop.
//
// It deliberately does not claim "settled". Paid invoices and expired ones are
// both removed from storage, so their absence proves nothing on its own. The
// caller knows what the note had before it paid; the two figures together are
// what settle the question.
func PromoteStatusHandler(storage *Storage, invoices *InvoiceManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			writeError(w, http.StatusMethodNotAllowed, "use GET")
			return
		}

		hash := r.URL.Query().Get("payment_hash")
		note := normalizeEventID(r.URL.Query().Get("note"))
		if hash == "" {
			writeError(w, http.StatusBadRequest, "payment_hash is required")
			return
		}

		// Ask the wallet about this one invoice while somebody is waiting on it.
		// This is what makes a payment show up in seconds. The relay used to
		// poll every pending invoice on a timer instead, which flooded the
		// wallet's relay until it refused everything, new invoices included.
		if _, waiting := storage.GetPendingInvoice(hash); waiting && invoices != nil {
			checkCtx, cancel := context.WithTimeout(r.Context(), promoteStatusCheckTimeout)
			invoices.CheckNow(checkCtx, hash)
			cancel()
		}

		status := promoteStatus{NoteID: note}
		if invoice, waiting := storage.GetPendingInvoice(hash); waiting {
			status.Pending = true
			status.NoteID = invoice.PostID
		}
		if status.NoteID != "" {
			if post, known := storage.GetPost(status.NoteID); known {
				status.SatsPaid = post.TotalSatsPaid
			}
		}

		writeJSON(w, http.StatusOK, status)
	}
}
