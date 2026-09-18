package main

import (
	"encoding/json"
	"github.com/nbd-wtf/go-nostr"
	"net/http"
	"strings"
	"testing"
)

func TestExtendedBillboardValidation(t *testing.T) {
	event := &nostr.Event{Content: "First\r\nSecond Third https://example.com/a.png " + strings.Repeat("😀", 80) + strings.Repeat("界", 80)}
	for _, template := range []string{"terminal", "split-flap", "glitch", "poster", "slides"} {
		t.Run(template, func(t *testing.T) {
			config := testBillboard("First")
			config.Template = template
			if template == "slides" {
				config.Slides = []string{"First", "Second", "Third"}
			}
			if err := config.validate(event); err != nil {
				t.Fatal(err)
			}
			config.Text = "Invented"
			if template == "slides" {
				config.Slides[0] = config.Text
			}
			if config.validate(event) == nil {
				t.Fatal("accepted invented text")
			}
		})
	}
	invalid := []func(*BillboardConfig){
		func(b *BillboardConfig) { b.Slides = nil },
		func(b *BillboardConfig) { b.Slides = []string{} },
		func(b *BillboardConfig) { b.Slides = []string{"First", " "} },
		func(b *BillboardConfig) { b.Slides = []string{"First", "Second", "Third", "First"} },
		func(b *BillboardConfig) { b.Slides = []string{"First", "Invented"} },
		func(b *BillboardConfig) { b.Text = "Second" },
		func(b *BillboardConfig) { b.Template = "led" },
		func(b *BillboardConfig) { b.Image = "https://example.com/a.png" },
	}
	for i, change := range invalid {
		config := testBillboard("First")
		config.Template = "slides"
		config.Slides = []string{"First", "Second"}
		change(config)
		if config.validate(event) == nil {
			t.Fatalf("accepted invalid slide config %d", i)
		}
	}
	first, second := strings.Repeat("😀", 80), strings.Repeat("界", 80)
	config := testBillboard(first)
	config.Template, config.Slides = "slides", []string{first, second}
	if err := config.validate(event); err != nil {
		t.Fatal(err)
	}
	config.Slides[1] += "Third"
	if config.validate(event) == nil {
		t.Fatal("accepted more than 160 characters across slides")
	}
	config = testBillboard("First\r\nSecond")
	config.Template = "poster"
	if err := config.validate(event); err != nil {
		t.Fatal(err)
	}
	config.Image = "https://example.com/a.png"
	if err := config.validate(event); err != nil {
		t.Fatal(err)
	}
	config.Image = "https://example.com/other.png"
	if config.validate(event) == nil {
		t.Fatal("accepted image outside original note")
	}
}

func TestAdditionalBillboardTemplatesSettleAndSurviveBoost(t *testing.T) {
	for _, template := range []string{"terminal", "split-flap", "glitch", "poster", "slides"} {
		t.Run(template, func(t *testing.T) {
			storage, manager, monitor, id := billboardFixture(t)
			expireBillboardPost(storage, id)
			config := testBillboard("a note")
			config.Template = template
			if template == "slides" {
				config.Slides = []string{"a note", "somebody wants promoted"}
			}
			response := postPromote(t, PromoteHandler(storage, manager, NewPostFetcher(nil)),
				promoteRequest{Note: id, AmountSats: 21, Billboard: config}, "1.2.3.4")
			if response.Code != http.StatusOK {
				t.Fatalf("invoice failed: %s", response.Body.String())
			}
			var invoice struct {
				PaymentHash string `json:"payment_hash"`
				AmountSats  int64  `json:"amount_sats"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &invoice); err != nil {
				t.Fatal(err)
			}
			if invoice.AmountSats != 121 {
				t.Fatal("template changed appearance fee")
			}
			if err := monitor.ProcessInvoicePayment(invoice.PaymentHash, 121); err != nil {
				t.Fatal(err)
			}
			reloaded, err := NewStorage(storage.dataFile)
			if err != nil {
				t.Fatal(err)
			}
			post, _ := reloaded.GetPost(id)
			if post.Billboard == nil || post.Billboard.Template != template || post.TotalSatsPaid != 22 {
				t.Fatal("appearance or ranking credit lost")
			}
			if template == "slides" {
				if len(post.Billboard.Slides) != 2 || post.Billboard.Slides[1] != config.Slides[1] {
					t.Fatal("slides lost on restart")
				}
				post.Billboard.Slides[1] = "changed snapshot"
				snapshot, _ := reloaded.GetPost(id)
				if snapshot.Billboard.Slides[1] != config.Slides[1] {
					t.Fatal("caller mutated stored slides")
				}
			}
			if err := reloaded.AddPayment(id, 10, nil); err != nil {
				t.Fatal(err)
			}
			post, _ = reloaded.GetPost(id)
			if post.TotalSatsPaid != 32 || post.Billboard.Template != template {
				t.Fatal("boost changed appearance")
			}
			if template == "slides" && post.Billboard.Slides[1] != config.Slides[1] {
				t.Fatal("boost changed slides")
			}
			if ok, err := post.Event.CheckSignature(); err != nil || !ok {
				t.Fatal("original signature changed")
			}
		})
	}
}
