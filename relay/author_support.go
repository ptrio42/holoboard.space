package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/btcsuite/btcd/btcutil/bech32"
	"github.com/btcsuite/btcd/chaincfg"
	"github.com/lightningnetwork/lnd/zpay32"
	"github.com/nbd-wtf/go-nostr"
)

// AuthorSupport only prepares and verifies payments sent directly to the author.
// It never receives funds, sends payments, or adds author tips to board ranking.
type AuthorSupport struct {
	storage *Storage
	fetcher *PostFetcher
	client  *http.Client
	profile func(context.Context, string, []string) (*nostr.Event, error)
	mu      sync.Mutex
	cache   map[string]authorEndpoint
}

type authorEndpoint struct {
	Author      string `json:"author"`
	Available   bool   `json:"available"`
	ReasonCode  string `json:"reason_code,omitempty"`
	Reason      string `json:"reason,omitempty"`
	MinSats     int64  `json:"min_sats"`
	MaxSats     int64  `json:"max_sats"`
	AllowsNostr bool   `json:"allows_nostr"`
	NostrPubkey string `json:"nostr_pubkey,omitempty"`
	callback    string
	metadata    string
	expires     time.Time
}

var errAuthorHasNoAddress = fmt.Errorf("author has no Lightning payment address")

// AuthorInvoiceContext pins the recipient and provider that issued an invoice.
// It contains no wallet credentials, payment preimages or ranking credit.
type AuthorInvoiceContext struct {
	NoteID        string `json:"note_id"`
	Author        string `json:"author"`
	NostrPubkey   string `json:"nostr_pubkey,omitempty"`
	InvoiceDigest string `json:"invoice_digest"`
}

func (s *Storage) AddAuthorInvoice(hash string, record AuthorInvoiceContext) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if previous, exists := s.authorInvoices[hash]; exists {
		if previous != record {
			return fmt.Errorf("author invoice conflicts with a previously issued invoice")
		}
		return nil
	}
	s.authorInvoices[hash] = record
	if err := s.save(); err != nil {
		delete(s.authorInvoices, hash)
		return err
	}
	return nil
}

func (s *Storage) GetAuthorInvoice(hash string) (AuthorInvoiceContext, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.authorInvoices[hash]
	return record, ok
}

func authorInvoiceDigest(invoice string) string {
	digest := sha256.Sum256([]byte(invoice))
	return hex.EncodeToString(digest[:])
}

// Only a valid signed profile can establish that an address is absent.
// Failed discovery leaves the requested allocation unchanged.
func (a *AuthorSupport) campaignShare(ctx context.Context, note *nostr.Event, share int, hints []string) int {
	if note == nil || share == 0 {
		return share
	}
	profile, err := a.profile(ctx, note.PubKey, hints)
	if err == nil && validRecipientProfile(profile, note.PubKey) && profileHasNoPaymentAddress(profile) {
		return 0
	}
	return share
}

func publicPaymentURL(value string) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || (u.Port() != "" && u.Port() != "443") || u.Fragment != "" {
		return nil, fmt.Errorf("payment endpoint must use public HTTPS")
	}
	host := strings.ToLower(u.Hostname())
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return nil, fmt.Errorf("private payment endpoint is not allowed")
	}
	if ip := net.ParseIP(host); ip != nil && !publicPaymentIP(ip) {
		return nil, fmt.Errorf("private payment endpoint is not allowed")
	}
	return u, nil
}

func publicPaymentIP(ip net.IP) bool {
	// Shared carrier space is not covered by net.IP.IsPrivate.
	shared := net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}
	return ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !ip.IsUnspecified() && !shared.Contains(ip)
}

func paymentHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		if len(ips) == 0 {
			return nil, fmt.Errorf("payment host has no public address")
		}
		for _, ip := range ips {
			if !publicPaymentIP(ip.IP) {
				return nil, fmt.Errorf("payment host resolves to a private address")
			}
		}
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
	}
	return &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
}

func NewAuthorSupport(storage *Storage, fetcher *PostFetcher) *AuthorSupport {
	a := &AuthorSupport{storage: storage, fetcher: fetcher, client: paymentHTTPClient(), cache: make(map[string]authorEndpoint)}
	a.profile = func(ctx context.Context, author string, hints []string) (*nostr.Event, error) {
		sources := dedupe(append(append([]string{}, fetcher.relays...), hints...))
		profileCtx, cancel := context.WithTimeout(ctx, profileFetchTimeout)
		defer cancel()
		profile, _ := findRecipientProfile(profileCtx, author, sources)
		if profile == nil {
			return nil, fmt.Errorf("author profile is unavailable")
		}
		return profile, nil
	}
	return a
}

func (a *AuthorSupport) readJSON(ctx context.Context, endpoint string, out any) error {
	if _, err := publicPaymentURL(endpoint); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	response, err := a.client.Do(req)
	if err != nil {
		return fmt.Errorf("author wallet did not respond")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("author wallet returned an error")
	}
	return json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(out)
}

func (a *AuthorSupport) note(ctx context.Context, reference string) (*nostr.Event, error) {
	id := normalizeEventID(reference)
	if !isHex64(id) {
		reference = extractEventIDFromText(reference)
		id = normalizeEventID(reference)
	}
	if !isHex64(id) {
		return nil, fmt.Errorf("invalid note reference")
	}
	if a.storage.IsRemoved(id) {
		return nil, fmt.Errorf("note was removed by the operator")
	}
	if post, ok := a.storage.GetPost(id); ok {
		return post.Event, nil
	}
	hints, author := noteHints(reference)
	event, err := a.fetcher.FetchPostFrom(ctx, id, hints, author)
	if err != nil {
		return nil, err
	}
	if !isPromotable(event.Kind) {
		return nil, fmt.Errorf("unsupported note kind")
	}
	return event, nil
}

func (a *AuthorSupport) endpoint(ctx context.Context, author string, hints ...string) (authorEndpoint, error) {
	a.mu.Lock()
	cached, ok := a.cache[author]
	a.mu.Unlock()
	if ok && cached.expires.After(time.Now()) {
		return cached, nil
	}
	profile, err := a.profile(ctx, author, hints)
	if err != nil {
		return authorEndpoint{}, err
	}
	if profile == nil || profile.Kind != 0 || profile.PubKey != author || profile.GetID() != profile.ID {
		return authorEndpoint{}, fmt.Errorf("invalid author profile")
	}
	if valid, err := profile.CheckSignature(); err != nil || !valid {
		return authorEndpoint{}, fmt.Errorf("invalid author profile signature")
	}
	metadata := paymentProfileMetadata(profile)
	if metadata == nil {
		return authorEndpoint{}, fmt.Errorf("invalid author profile metadata")
	}
	var endpoint string
	if metadata.Lud16 != "" {
		user, domain, found := strings.Cut(metadata.Lud16, "@")
		if !found || user == "" || strings.ContainsAny(domain, "/?#@:") {
			return authorEndpoint{}, fmt.Errorf("author Lightning address is invalid")
		}
		endpoint = "https://" + domain + "/.well-known/lnurlp/" + url.PathEscape(user)
	} else if metadata.Lud06 != "" {
		prefix, words, err := bech32.DecodeNoLimit(metadata.Lud06)
		if err != nil || prefix != "lnurl" {
			return authorEndpoint{}, fmt.Errorf("author LNURL is invalid")
		}
		decoded, err := bech32.ConvertBits(words, 5, 8, false)
		if err != nil {
			return authorEndpoint{}, fmt.Errorf("author LNURL is invalid")
		}
		endpoint = string(decoded)
	} else {
		return authorEndpoint{}, errAuthorHasNoAddress
	}
	var pay struct {
		Tag      string `json:"tag"`
		Callback string `json:"callback"`
		Metadata string `json:"metadata"`
		Min      int64  `json:"minSendable"`
		Max      int64  `json:"maxSendable"`
		Allows   bool   `json:"allowsNostr"`
		Key      string `json:"nostrPubkey"`
	}
	if err := a.readJSON(ctx, endpoint, &pay); err != nil {
		return authorEndpoint{}, err
	}
	if pay.Tag != "payRequest" || pay.Min < 1 || pay.Min > promoteMaxSats*1000 || pay.Max < pay.Min || !json.Valid([]byte(pay.Metadata)) {
		return authorEndpoint{}, fmt.Errorf("author wallet payment details are invalid")
	}
	if _, err := publicPaymentURL(pay.Callback); err != nil {
		return authorEndpoint{}, err
	}
	if pay.Max > promoteMaxSats*1000 {
		pay.Max = promoteMaxSats * 1000
	}
	details := authorEndpoint{Author: author, Available: true, MinSats: (pay.Min + 999) / 1000, MaxSats: pay.Max / 1000, AllowsNostr: pay.Allows && isHex64(pay.Key), NostrPubkey: pay.Key, callback: pay.Callback, metadata: pay.Metadata, expires: time.Now().Add(5 * time.Minute)}
	if details.MinSats > details.MaxSats {
		return authorEndpoint{}, fmt.Errorf("author wallet does not accept whole sats")
	}
	a.mu.Lock()
	for key, value := range a.cache {
		if !value.expires.After(time.Now()) {
			delete(a.cache, key)
		}
	}
	if len(a.cache) >= 128 {
		for key := range a.cache {
			delete(a.cache, key)
			break
		}
	}
	a.cache[author] = details
	a.mu.Unlock()
	return details, nil
}

func decodeSupportInvoice(bolt11 string) (*zpay32.Invoice, error) {
	invoice, err := zpay32.Decode(bolt11, &chaincfg.MainNetParams)
	if err != nil || invoice.PaymentHash == nil || invoice.MilliSat == nil || invoice.DescriptionHash == nil {
		return nil, fmt.Errorf("author wallet returned an invalid Lightning invoice")
	}
	return invoice, nil
}

func (a *AuthorSupport) Handler() http.HandlerFunc {
	limiter := newRateLimiter(20, 10*time.Minute)
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			writeError(w, 405, "use POST")
			return
		}
		if !limiter.allow(clientAddress(r), time.Now()) {
			writeError(w, 429, "too many author payment requests")
			return
		}
		var req struct {
			Note     string       `json:"note"`
			Amount   int64        `json:"amount_sats"`
			Zap      *nostr.Event `json:"zap_request"`
			Invoice  string       `json:"invoice"`
			Preimage string       `json:"preimage"`
			Receipt  *nostr.Event `json:"receipt"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384)).Decode(&req); err != nil {
			writeError(w, 400, "invalid author payment request")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		if r.URL.Path == "/api/support/verify" && req.Preimage != "" {
			invoice, err := decodeSupportInvoice(req.Invoice)
			proof, proofErr := hex.DecodeString(req.Preimage)
			if err != nil || proofErr != nil || len(proof) != 32 {
				writeError(w, 400, "invalid payment proof")
				return
			}
			hash := sha256.Sum256(proof)
			if hash != *invoice.PaymentHash {
				writeError(w, 400, "payment proof does not match this invoice")
				return
			}
			writeJSON(w, 200, map[string]bool{"verified": true})
			return
		}
		if r.URL.Path == "/api/support/verify" && req.Receipt != nil {
			invoice, err := decodeSupportInvoice(req.Invoice)
			if err != nil {
				writeError(w, 400, "invalid author invoice")
				return
			}
			if record, known := a.storage.GetAuthorInvoice(hex.EncodeToString(invoice.PaymentHash[:])); known {
				id := normalizeEventID(req.Note)
				if !isHex64(id) {
					id = normalizeEventID(extractEventIDFromText(req.Note))
				}
				resolver := NewLNURLResolver()
				resolver.resolved = true
				resolver.pubkeys["author"] = record.NostrPubkey
				zap, err := ValidateZapReceipt(req.Receipt, record.Author, resolver)
				if record.InvoiceDigest != authorInvoiceDigest(req.Invoice) || id != record.NoteID || !isHex64(record.NostrPubkey) || err != nil || zap.PaymentHash != hex.EncodeToString(invoice.PaymentHash[:]) || firstTag(zap.Request, "e") != record.NoteID {
					writeError(w, 400, "receipt does not match this author payment")
					return
				}
				writeJSON(w, 200, map[string]bool{"verified": true})
				return
			}
		}
		note, err := a.note(ctx, req.Note)
		if err != nil {
			writeError(w, 400, "could not resolve that note")
			return
		}
		hints, _ := noteHints(req.Note)
		if quote, ok := a.storage.QuotePublication(note.ID); ok && quote.Event != nil {
			_, quoteHints, _ := quotedNoteReference(quote.Event)
			hints = append(hints, quoteHints...)
		}
		details, err := a.endpoint(ctx, note.PubKey, hints...)
		if r.URL.Path == "/api/support" {
			if err != nil {
				code, reason := "unavailable", "Author support is unavailable. Choose visibility only or try again later."
				if err == errAuthorHasNoAddress {
					code, reason = "no_address", "The author has no Lightning payment address."
				}
				writeJSON(w, 200, authorEndpoint{Author: note.PubKey, ReasonCode: code, Reason: reason})
				return
			}
			writeJSON(w, 200, details)
			return
		}
		if err != nil {
			writeError(w, 502, "author wallet is unavailable; no money was redirected")
			return
		}
		if r.URL.Path == "/api/support/verify" {
			invoice, err := decodeSupportInvoice(req.Invoice)
			if err != nil || req.Receipt == nil || !details.AllowsNostr {
				writeError(w, 400, "no valid author payment receipt")
				return
			}
			resolver := NewLNURLResolver()
			resolver.resolved = true
			resolver.pubkeys["author"] = details.NostrPubkey
			zap, err := ValidateZapReceipt(req.Receipt, note.PubKey, resolver)
			if err != nil || zap.PaymentHash != hex.EncodeToString(invoice.PaymentHash[:]) || firstTag(zap.Request, "e") != note.ID {
				writeError(w, 400, "receipt does not match this author payment")
				return
			}
			writeJSON(w, 200, map[string]bool{"verified": true})
			return
		}
		if r.URL.Path != "/api/support/invoice" {
			writeError(w, 404, "unknown author payment endpoint")
			return
		}
		if req.Amount < details.MinSats || req.Amount > details.MaxSats || req.Amount > promoteMaxSats {
			writeError(w, 400, fmt.Sprintf("author payment must be between %d and %d sats", details.MinSats, details.MaxSats))
			return
		}
		u, _ := url.Parse(details.callback)
		query := u.Query()
		query.Set("amount", fmt.Sprint(req.Amount*1000))
		description := details.metadata
		if req.Zap != nil {
			if !details.AllowsNostr || req.Zap.Kind != 9734 || req.Zap.GetID() != req.Zap.ID || countTags(req.Zap, "p") != 1 || firstTag(req.Zap, "p") != note.PubKey || countTags(req.Zap, "e") != 1 || firstTag(req.Zap, "e") != note.ID || firstTag(req.Zap, "amount") != fmt.Sprint(req.Amount*1000) {
				writeError(w, 400, "zap request does not match the author payment")
				return
			}
			if valid, err := req.Zap.CheckSignature(); err != nil || !valid {
				writeError(w, 400, "invalid zap signature")
				return
			}
			encoded, _ := json.Marshal(req.Zap)
			description = string(encoded)
			query.Set("nostr", description)
		}
		u.RawQuery = query.Encode()
		var response struct {
			Invoice string `json:"pr"`
			Status  string `json:"status"`
		}
		if err := a.readJSON(ctx, u.String(), &response); err != nil || response.Status == "ERROR" {
			writeError(w, 502, "author wallet could not issue an invoice")
			return
		}
		invoice, err := decodeSupportInvoice(response.Invoice)
		descriptionHash := sha256.Sum256([]byte(description))
		if err != nil || int64(*invoice.MilliSat) != req.Amount*1000 || *invoice.DescriptionHash != descriptionHash {
			writeError(w, 502, "author invoice amount or payment description was incorrect")
			return
		}
		expires := invoice.Timestamp.Add(invoice.Expiry())
		if !expires.After(time.Now()) {
			writeError(w, 502, "author wallet issued an expired invoice")
			return
		}
		hash := hex.EncodeToString(invoice.PaymentHash[:])
		if err := a.storage.AddAuthorInvoice(hash, AuthorInvoiceContext{NoteID: note.ID, Author: note.PubKey, NostrPubkey: details.NostrPubkey, InvoiceDigest: authorInvoiceDigest(response.Invoice)}); err != nil {
			writeError(w, 503, "could not save author invoice verification details; no payment was requested")
			return
		}
		writeJSON(w, 200, map[string]any{"invoice": response.Invoice, "payment_hash": hex.EncodeToString(invoice.PaymentHash[:]), "amount_sats": req.Amount, "expires_at": expires.Unix(), "author": note.PubKey, "nostr_pubkey": details.NostrPubkey})
	}
}
