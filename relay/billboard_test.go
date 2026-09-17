package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip19"
)

func testBillboard(text string) *BillboardConfig {
	return &BillboardConfig{Template: "led", Color: "cyan", Size: "medium", Speed: "normal", Text: text}
}

func billboardFixture(t *testing.T) (*Storage, *InvoiceManager, *PaymentMonitor, string) {
	t.Helper()
	storage := newTestStorage(t)
	id := seedPromotedPost(t, storage, nostr.GeneratePrivateKey())
	monitor := NewPaymentMonitor(storage, "relay", NewPostFetcher(nil), NewLNURLResolver())
	manager := NewInvoiceManager(NewMockLightningBackend(), storage, monitor, 1000)
	return storage, manager, monitor, id
}

func TestBillboardFeeDoesNotBuyRank(t *testing.T) {
	storage, manager, monitor, id := billboardFixture(t)
	amount := int64(500)
	expireBillboardPost(storage, id)
	before, _ := storage.GetPost(id)
	rec := postPromote(t, PromoteHandler(storage, manager, NewPostFetcher(nil)), promoteRequest{Note: id, AmountSats: amount, Billboard: testBillboard("somebody wants a new slogan")}, "1.2.3.4")
	if rec.Code != 400 {
		t.Fatalf("text outside original was accepted: %s", rec.Body.String())
	}
	rec = postPromote(t, PromoteHandler(storage, manager, NewPostFetcher(nil)), promoteRequest{Note: id, AmountSats: amount, Billboard: testBillboard("somebody wants promoted")}, "1.2.3.4")
	// The original says "somebody wants promoted"; no new advertising copy.
	if rec.Code != 200 {
		t.Fatalf("mint: %d %s", rec.Code, rec.Body.String())
	}
	var invoice promoteResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &invoice); err != nil {
		t.Fatal(err)
	}
	if invoice.AmountSats != amount+100 || invoice.PromotionSats != amount || invoice.BillboardFee != 100 {
		t.Fatalf("wrong allocation: %+v", invoice)
	}
	if post, _ := storage.GetPost(id); post.Billboard != nil {
		t.Fatal("unpaid style reached the board")
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := monitor.ProcessInvoicePayment(invoice.PaymentHash, 999999); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	post, _ := storage.GetPost(id)
	if post.TotalSatsPaid != before.TotalSatsPaid+amount || post.Billboard == nil {
		t.Fatalf("payment misallocated: %+v", post)
	}
	receipt, ok := storage.InvoiceReceipt(invoice.PaymentHash)
	if !ok || !receipt.BillboardApplied || receipt.PromotionSats != amount || receipt.FeeConverted || receipt.AmountSats != amount+100 || receipt.BillboardFee != 100 {
		t.Fatalf("wrong receipt: %+v", receipt)
	}
	status := httptest.NewRecorder()
	PromoteStatusHandler(storage, nil)(status, httptest.NewRequest("GET", "/api/promote/status?payment_hash="+invoice.PaymentHash, nil))
	var progress promoteStatus
	if err := json.Unmarshal(status.Body.Bytes(), &progress); err != nil {
		t.Fatal(err)
	}
	if !progress.Settled || progress.Pending || progress.Receipt == nil {
		t.Fatalf("missing exact settlement: %+v", progress)
	}
	reloaded, err := NewStorage(storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	if post, _ := reloaded.GetPost(id); post.Billboard == nil {
		t.Fatal("style lost on restart")
	}
	if err := NewPaymentMonitor(reloaded, "relay", NewPostFetcher(nil), nil).ProcessInvoicePayment(invoice.PaymentHash, 99999); err != nil {
		t.Fatal(err)
	}
	if post, _ := reloaded.GetPost(id); post.TotalSatsPaid != before.TotalSatsPaid+amount {
		t.Fatal("restart allowed duplicate credit")
	}
}

func TestBillboardReservationAndFirstPaidStyle(t *testing.T) {
	storage, manager, monitor, id := billboardFixture(t)
	expireBillboardPost(storage, id)
	post, _ := storage.GetPost(id)
	config := testBillboard("a note")
	first, err := manager.GenerateBillboardInvoice(context.Background(), id, 10, nil, "", config, false, post.Event)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.GenerateBillboardInvoice(context.Background(), id, 20, nil, "", config, false, post.Event); !errors.Is(err, errBillboardConflict) {
		t.Fatal("two live style invoices were offered")
	}
	// A late receipt can arrive after a second invoice has been issued.
	storage.mu.Lock()
	storage.pendingInvoices[first.PaymentHash].ExpiresAt = time.Now().Add(-time.Second)
	storage.mu.Unlock()
	secondConfig := testBillboard("somebody")
	secondConfig.Color = "pink"
	second, err := manager.GenerateBillboardInvoice(context.Background(), id, 20, nil, "", secondConfig, false, post.Event)
	if err != nil {
		t.Fatal(err)
	}
	if err := monitor.ProcessInvoicePayment(second.PaymentHash, 120); err != nil {
		t.Fatal(err)
	}
	if err := monitor.ProcessInvoicePayment(first.PaymentHash, 110); err != nil {
		t.Fatal(err)
	}
	after, _ := storage.GetPost(id)
	if after.Billboard.Color != "pink" || after.TotalSatsPaid != 131 {
		t.Fatalf("first paid style or converted fee lost: %+v", after)
	}
	receipt, _ := storage.InvoiceReceipt(first.PaymentHash)
	if !receipt.FeeConverted || receipt.BillboardApplied {
		t.Fatal("late competing purchase did not convert its fee")
	}
	if err := storage.AddPayment(id, 1, nil); err != nil {
		t.Fatal(err)
	}
	after, _ = storage.GetPost(id)
	if after.Billboard.Color != "pink" {
		t.Fatal("boost changed appearance")
	}
	if _, err := manager.GenerateBillboardInvoice(context.Background(), id, 0, nil, "", config, true, post.Event); !errors.Is(err, errBillboardConflict) {
		t.Fatal("active style was replaceable")
	}
}

func expireBillboardPost(storage *Storage, id string) {
	storage.mu.Lock()
	defer storage.mu.Unlock()
	post := storage.posts[id]
	for i := range post.Payments {
		post.Payments[i].At = time.Now().Add(-100 * rankHalfLife)
	}
}

func TestBillboardExpiresAndMustBePurchasedAgain(t *testing.T) {
	storage, manager, monitor, id := billboardFixture(t)
	expireBillboardPost(storage, id)
	post, _ := storage.GetPost(id)
	invoice, err := manager.GenerateBillboardInvoice(context.Background(), id, 10, nil, "", testBillboard("a note"), false, post.Event)
	if err != nil {
		t.Fatal(err)
	}
	if err := monitor.ProcessInvoicePayment(invoice.PaymentHash, 110); err != nil {
		t.Fatal(err)
	}
	expireBillboardPost(storage, id)
	if len(storage.Ledger()) != 0 {
		t.Fatal("expired billboard remained visible")
	}
	if err := storage.AddPayment(id, 10, nil); err != nil {
		t.Fatal(err)
	}
	post, _ = storage.GetPost(id)
	if post.Billboard != nil {
		t.Fatal("ordinary revival restored paid appearance")
	}
	if _, err := manager.GenerateBillboardInvoice(context.Background(), id, 10, nil, "", testBillboard("a note"), false, post.Event); !errors.Is(err, errBillboardConflict) {
		t.Fatal("revived standard appearance was replaceable")
	}
	expireBillboardPost(storage, id)
	invoice, err = manager.GenerateBillboardInvoice(context.Background(), id, 10, nil, "", testBillboard("a note"), false, post.Event)
	if err != nil {
		t.Fatal(err)
	}
	if err := monitor.ProcessInvoicePayment(invoice.PaymentHash, 110); err != nil {
		t.Fatal(err)
	}
	if storage.Ledger()[0].Billboard == nil {
		t.Fatal("repurchased appearance did not reach ledger")
	}
}

func TestLegacyAppearanceOnlyInvoiceConvertsFee(t *testing.T) {
	for _, state := range []string{"active", "expired", "revived"} {
		t.Run(state, func(t *testing.T) {
			storage, _, monitor, id := billboardFixture(t)
			post, _ := storage.GetPost(id)
			invoice := &PendingInvoice{PostID: id, PaymentHash: "old-style-only", AmountSats: 100, BillboardFee: 100,
				Billboard: testBillboard("a note"), StyleOnly: true, ActivityID: post.ActivityID, Event: post.Event}
			if err := storage.AddPendingInvoice(invoice); err != nil {
				t.Fatal(err)
			}
			if state != "active" {
				expireBillboardPost(storage, id)
			}
			if state == "revived" {
				if err := storage.AddPayment(id, 10, nil); err != nil {
					t.Fatal(err)
				}
			}
			storage.mu.Lock()
			err := storage.save()
			storage.mu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			reloaded, err := NewStorage(storage.dataFile)
			if err != nil {
				t.Fatal(err)
			}
			monitor = NewPaymentMonitor(reloaded, "relay", NewPostFetcher(nil), nil)
			if err := monitor.ProcessInvoicePayment(invoice.PaymentHash, 100); err != nil {
				t.Fatal(err)
			}
			after, _ := reloaded.GetPost(id)
			receipt, _ := reloaded.InvoiceReceipt(invoice.PaymentHash)
			if after.Billboard != nil || !receipt.FeeConverted || receipt.BillboardApplied || receipt.PromotionSats != 100 || receipt.BillboardFee != 0 {
				t.Fatalf("legacy upgrade changed appearance: %+v %+v", after, receipt)
			}
		})
	}
}

func TestBillboardSettlementRollsBackOnSaveFailure(t *testing.T) {
	storage, manager, monitor, id := billboardFixture(t)
	expireBillboardPost(storage, id)
	post, _ := storage.GetPost(id)
	invoice, err := manager.GenerateBillboardInvoice(context.Background(), id, 50, nil, "", testBillboard("a note"), false, post.Event)
	if err != nil {
		t.Fatal(err)
	}
	path := storage.dataFile
	storage.dataFile = filepath.Join(t.TempDir(), "missing", "data.json")
	if err := monitor.ProcessInvoicePayment(invoice.PaymentHash, 150); err == nil {
		t.Fatal("failed disk write reported success")
	}
	after, _ := storage.GetPost(id)
	if after.TotalSatsPaid != 1 || after.Billboard != nil {
		t.Fatal("failed write left partial credit")
	}
	if _, ok := storage.InvoiceReceipt(invoice.PaymentHash); ok {
		t.Fatal("failed write left a receipt")
	}
	storage.dataFile = path
	if err := monitor.ProcessInvoicePayment(invoice.PaymentHash, 150); err != nil {
		t.Fatal(err)
	}
	after, _ = storage.GetPost(id)
	if after.TotalSatsPaid != 51 {
		t.Fatal("retry credited twice")
	}
}

func TestBillboardValidation(t *testing.T) {
	event := &nostr.Event{Content: "Hello 世界 https://example.com/a.png. https://example.com/b.webp?x=1"}
	for _, change := range []func(*BillboardConfig){
		func(b *BillboardConfig) { b.Text = "invented" }, func(b *BillboardConfig) { b.Text = " " },
		func(b *BillboardConfig) { b.Template = "html" }, func(b *BillboardConfig) { b.Color = "red" },
		func(b *BillboardConfig) { b.Size = "giant" }, func(b *BillboardConfig) { b.Speed = "instant" },
		func(b *BillboardConfig) { b.Template = "image-led"; b.Image = "javascript:alert(1)" },
		func(b *BillboardConfig) { b.Template = "image-led"; b.Image = "https://example.com/other.png" },
	} {
		config := testBillboard("Hello")
		change(config)
		if config.validate(event) == nil {
			t.Fatalf("accepted %+v", config)
		}
	}
	config := testBillboard("世界")
	if err := config.validate(event); err != nil {
		t.Fatal(err)
	}
	config.Template = "image-led"
	config.Image = "https://example.com/a.png"
	if err := config.validate(event); err != nil {
		t.Fatal(err)
	}
	event.Content = strings.Repeat("😀", 160)
	config = testBillboard(event.Content)
	if err := config.validate(event); err != nil {
		t.Fatal(err)
	}
	event.Content += "😀"
	config.Text = event.Content
	if config.validate(event) == nil {
		t.Fatal("accepted overlong Unicode text")
	}
}

func TestPreviewDoesNotPromoteAndRejectsRemovedNotes(t *testing.T) {
	storage, _, _, id := billboardFixture(t)
	handler := PreviewHandler(storage, NewPostFetcher(nil))
	rec := postPromote(t, handler, map[string]string{"note": id}, "1.2.3.4")
	if rec.Code != http.StatusOK || len(storage.ListPendingInvoices()) != 0 {
		t.Fatalf("preview created payment state: %d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Event *nostr.Event `json:"event"`
		Fee   int64        `json:"billboard_fee_sats"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Event.ID != id || body.Fee != 100 {
		t.Fatal("preview missing event or current price")
	}
	if _, err := storage.RemovePost(id); err != nil {
		t.Fatal(err)
	}
	rec = postPromote(t, handler, map[string]string{"note": id}, "1.2.3.4")
	if rec.Code != http.StatusConflict {
		t.Fatal("preview tried to fetch removed content")
	}
}

func TestPreviewFetchesUnpaidNoteAndBillboardSettlementSurvivesRestart(t *testing.T) {
	storage := newTestStorage(t)
	relayURL := startTestRelay(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	public, err := nostr.RelayConnect(ctx, relayURL)
	if err != nil {
		t.Fatal(err)
	}
	defer public.Close()
	note := &nostr.Event{Kind: 1, CreatedAt: nostr.Now(), Tags: nostr.Tags{}, Content: "A fresh signal 世界"}
	if err := note.Sign(nostr.GeneratePrivateKey()); err != nil {
		t.Fatal(err)
	}
	if err := public.Publish(ctx, *note); err != nil {
		t.Fatal(err)
	}
	reference, err := nip19.EncodeEvent(note.ID, []string{relayURL}, "")
	if err != nil {
		t.Fatal(err)
	}
	preview := PreviewHandler(storage, NewPostFetcher(nil))
	rec := postPromote(t, preview, map[string]string{"note": reference}, "1.2.3.4")
	if rec.Code != 200 {
		t.Fatalf("unpaid preview: %d %s", rec.Code, rec.Body.String())
	}
	if storage.HasPost(note.ID) || len(storage.ListPendingInvoices()) != 0 || len(storage.Ledger()) != 0 {
		t.Fatal("preview added unpaid content to board")
	}
	// With no relay hints the second request must use the preview cache.
	rec = postPromote(t, preview, map[string]string{"note": note.ID}, "1.2.3.4")
	if rec.Code != 200 {
		t.Fatalf("cached preview: %d %s", rec.Code, rec.Body.String())
	}
	manager := NewInvoiceManager(NewMockLightningBackend(), storage, nil, 1000)
	rec = postPromote(t, PromoteHandler(storage, manager, NewPostFetcher(nil)), promoteRequest{Note: reference, AmountSats: 21, Billboard: testBillboard("世界")}, "1.2.3.4")
	if rec.Code != 200 {
		t.Fatalf("unpaid billboard invoice: %d %s", rec.Code, rec.Body.String())
	}
	var invoice promoteResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &invoice); err != nil {
		t.Fatal(err)
	}
	if storage.HasPost(note.ID) {
		t.Fatal("minting an invoice published an unpaid note")
	}
	reloaded, err := NewStorage(storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	// The validated original travels with the pending purchase, so settlement
	// works even if its public relay is unavailable after a restart.
	monitor := NewPaymentMonitor(reloaded, "relay", NewPostFetcher(nil), nil)
	if err := monitor.ProcessInvoicePayment(invoice.PaymentHash, 121); err != nil {
		t.Fatal(err)
	}
	post, _ := reloaded.GetPost(note.ID)
	if post.TotalSatsPaid != 21 || post.Billboard.Text != "世界" {
		t.Fatal("first promotion allocation incorrect")
	}
	if ok, err := post.Event.CheckSignature(); err != nil || !ok {
		t.Fatal("billboard changed the original signed note")
	}
}

func TestStandardPromotionSettlesBeforeBillboard(t *testing.T) {
	for _, standard := range []string{"invoice", "zap"} {
		t.Run(standard, func(t *testing.T) {
			storage, manager, monitor, id := billboardFixture(t)
			expireBillboardPost(storage, id)
			post, _ := storage.GetPost(id)
			billboard, err := manager.GenerateBillboardInvoice(context.Background(), id, 20, nil, "", testBillboard("a note"), false, post.Event)
			if err != nil {
				t.Fatal(err)
			}
			if standard == "invoice" {
				invoice, err := manager.GeneratePromotionInvoice(context.Background(), id, 10, nil, "")
				if err != nil {
					t.Fatal(err)
				}
				if err := monitor.ProcessInvoicePayment(invoice.PaymentHash, 10); err != nil {
					t.Fatal(err)
				}
			} else if err := storage.AddPayment(id, 10, nil); err != nil {
				t.Fatal(err)
			}
			reloaded, err := NewStorage(storage.dataFile)
			if err != nil {
				t.Fatal(err)
			}
			monitor = NewPaymentMonitor(reloaded, "relay", NewPostFetcher(nil), nil)
			if err := monitor.ProcessInvoicePayment(billboard.PaymentHash, 120); err != nil {
				t.Fatal(err)
			}
			after, _ := reloaded.GetPost(id)
			receipt, _ := reloaded.InvoiceReceipt(billboard.PaymentHash)
			if after.Billboard != nil || after.TotalSatsPaid != 131 || !receipt.FeeConverted || receipt.PromotionSats != 120 {
				t.Fatalf("late billboard replaced standard appearance: %+v %+v", after, receipt)
			}
		})
	}
}

func TestActiveStandardNoteOnlyAllowsBoost(t *testing.T) {
	storage, manager, monitor, id := billboardFixture(t)
	handler := PromoteHandler(storage, manager, NewPostFetcher(nil))
	request := promoteRequest{Note: id, AmountSats: 50, Billboard: testBillboard("somebody wants promoted")}
	rec := postPromote(t, handler, request, "1.2.3.4")
	if rec.Code != http.StatusConflict || len(storage.ListPendingInvoices()) != 0 {
		t.Fatalf("active upgrade accepted: %d %s", rec.Code, rec.Body.String())
	}
	request.StyleOnly = true
	request.AmountSats = 0
	rec = postPromote(t, handler, request, "1.2.3.4")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("style-only accepted: %d", rec.Code)
	}
	post, _ := storage.GetPost(id)
	if _, err := manager.GenerateBillboardInvoice(context.Background(), id, 50, nil, "", request.Billboard, false, post.Event); !errors.Is(err, errBillboardConflict) {
		t.Fatal("invoice manager allowed active upgrade")
	}
	rec = postPromote(t, handler, promoteRequest{Note: id, AmountSats: 50}, "5.6.7.8")
	if rec.Code != http.StatusOK {
		t.Fatalf("public boost refused: %d %s", rec.Code, rec.Body.String())
	}
	var invoice promoteResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &invoice); err != nil {
		t.Fatal(err)
	}
	if err := monitor.ProcessInvoicePayment(invoice.PaymentHash, 50); err != nil {
		t.Fatal(err)
	}
	post, _ = storage.GetPost(id)
	if post.TotalSatsPaid != 51 || post.Billboard != nil {
		t.Fatal("boost changed standard appearance")
	}
}
