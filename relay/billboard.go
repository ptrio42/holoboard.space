package main

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/nbd-wtf/go-nostr"
)

var errBillboardConflict = errors.New("billboard unavailable")

// Introductory price, deliberately low. Existing invoices retain their price.
const billboardFeeSats int64 = 100
const billboardMaxText = 160

type BillboardConfig struct {
	Template string `json:"template"`
	Color    string `json:"color"`
	Size     string `json:"size"`
	Speed    string `json:"speed"`
	Text     string `json:"text"`
	Image    string `json:"image,omitempty"`
}

var imageURLPattern = regexp.MustCompile(`(?i)https?://[^\s<>"']+`)
var imageExtension = regexp.MustCompile(`(?i)\.(png|jpe?g|gif|webp|avif)(\?[^\s]*)?$`)

func billboardImages(content string) []string {
	images := []string{}
	for _, raw := range imageURLPattern.FindAllString(content, -1) {
		url := strings.TrimRight(raw, ".,;:!?")
		for strings.HasSuffix(url, ")") && !strings.Contains(url, "(") {
			url = strings.TrimRight(strings.TrimSuffix(url, ")"), ".,;:!?")
		}
		if imageExtension.MatchString(url) {
			images = append(images, url)
		}
	}
	return images
}

func (b *BillboardConfig) validate(event *nostr.Event) error {
	if b == nil {
		return nil
	}
	if b.Template != "led" && b.Template != "neon" && b.Template != "image-led" {
		return fmt.Errorf("choose a supported billboard template")
	}
	if b.Color != "cyan" && b.Color != "pink" && b.Color != "gold" {
		return fmt.Errorf("choose a supported billboard color")
	}
	if b.Size != "small" && b.Size != "medium" && b.Size != "large" {
		return fmt.Errorf("choose a supported text size")
	}
	if b.Speed != "slow" && b.Speed != "normal" && b.Speed != "fast" {
		return fmt.Errorf("choose a supported animation speed")
	}
	if event == nil || strings.TrimSpace(b.Text) == "" || utf8.RuneCountInString(b.Text) > billboardMaxText || !strings.Contains(event.Content, b.Text) {
		return fmt.Errorf("select up to %d characters from the original note", billboardMaxText)
	}
	if b.Template == "image-led" {
		for _, image := range billboardImages(event.Content) {
			if b.Image == image {
				return nil
			}
		}
		return fmt.Errorf("choose an image from the original note")
	}
	if b.Image != "" {
		return fmt.Errorf("only the image template accepts an image")
	}
	return nil
}

type InvoiceReceipt struct {
	NoteID           string `json:"note_id"`
	AmountSats       int64  `json:"amount_sats"`
	BillboardFee     int64  `json:"billboard_fee_sats"`
	PromotionSats    int64  `json:"promotion_sats"`
	BillboardApplied bool   `json:"billboard_applied"`
	FeeConverted     bool   `json:"fee_converted"`
}

func (s *Storage) InvoiceReceipt(hash string) (*InvoiceReceipt, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	receipt, ok := s.settledInvoices[hash]
	return receipt, ok
}

// SettleInvoice persists the credit, style, receipt and removal of the pending
// invoice together. Duplicate wallet notifications cannot credit it twice.
func (s *Storage) SettleInvoice(hash string, event *nostr.Event) (*nostr.Event, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.settledInvoices[hash]; ok {
		return nil, nil
	}
	invoice, ok := s.pendingInvoices[hash]
	if !ok {
		return nil, fmt.Errorf("no pending invoice found for payment hash: %s", hash)
	}
	if s.removed[invoice.PostID] {
		return nil, fmt.Errorf("post was removed by the operator")
	}
	original := s.posts[invoice.PostID]
	now := time.Now()
	post := &PromotedPost{PostID: invoice.PostID, Event: event}
	active := original != nil && original.weight(now) > 0
	if original != nil {
		*post = *original
		post.Payments = append([]Payment(nil), original.Payments...)
		// Preserve the legacy score when the first new payment is added.
		if len(post.Payments) == 0 {
			post.Payments = []Payment{{Sats: post.TotalSatsPaid, At: post.LastPaymentTimestamp}}
		}
	}
	if post.Event == nil {
		return nil, fmt.Errorf("cannot settle without the original note")
	}
	if !active {
		post.Billboard = nil
		post.ActivityID = fmt.Sprintf("%d", now.UnixNano())
	}
	promotion := invoice.AmountSats - invoice.BillboardFee
	applied := invoice.Billboard != nil && !active && !invoice.StyleOnly
	converted := invoice.BillboardFee > 0 && !applied
	if converted {
		promotion += invoice.BillboardFee
	}
	if promotion < 0 {
		return nil, fmt.Errorf("invalid stored invoice allocation")
	}
	if promotion > 0 {
		post.TotalSatsPaid += promotion
		post.LastPaymentTimestamp = now
		post.Payments = append(post.Payments, Payment{Sats: promotion, At: now})
	}
	if applied {
		config := *invoice.Billboard
		post.Billboard = &config
	}
	receipt := &InvoiceReceipt{NoteID: invoice.PostID, AmountSats: invoice.AmountSats, BillboardFee: invoice.AmountSats - promotion, PromotionSats: promotion, BillboardApplied: applied, FeeConverted: converted}
	s.posts[invoice.PostID] = post
	s.settledInvoices[hash] = receipt
	delete(s.pendingInvoices, hash)
	if err := s.save(); err != nil {
		if original == nil {
			delete(s.posts, invoice.PostID)
		} else {
			s.posts[invoice.PostID] = original
		}
		delete(s.settledInvoices, hash)
		s.pendingInvoices[hash] = invoice
		return nil, err
	}
	return post.Event, nil
}
