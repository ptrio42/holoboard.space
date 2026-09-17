package main

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/btcsuite/btcd/chaincfg"
	"github.com/nbd-wtf/go-nostr"
)

func TestExpiredInvoiceRecoversAfterWalletFailureAndRestart(t *testing.T) {
	storage, manager, monitor, id := billboardFixture(t)
	invoice, err := manager.GeneratePromotionInvoice(context.Background(), id, 21, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	storage.mu.Lock()
	storage.pendingInvoices[invoice.PaymentHash].ExpiresAt = time.Now().Add(-time.Second)
	err = storage.save()
	storage.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	backend := newStubBackend()
	backend.err = fmt.Errorf("wallet temporarily unavailable")
	manager = NewInvoiceManager(backend, storage, monitor, 1000)
	manager.reconcilePendingInvoices(context.Background())
	reloaded, err := NewStorage(storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := reloaded.GetPendingInvoice(invoice.PaymentHash); !ok {
		t.Fatal("expired invoice lost after failed check")
	}
	backend.err = nil
	backend.paid[invoice.PaymentHash] = 21
	monitor = NewPaymentMonitor(reloaded, testRelayPubkey, NewPostFetcher(nil), seedResolver())
	manager = NewInvoiceManager(backend, reloaded, monitor, 1000)
	manager.reconcilePendingInvoices(context.Background())
	post, _ := reloaded.GetPost(id)
	if post.TotalSatsPaid != 22 {
		t.Fatalf("late payment total=%d, want 22", post.TotalSatsPaid)
	}
}

func TestZapRetryAfterNoteFetchFailure(t *testing.T) {
	storage := newTestStorage(t)
	note := &nostr.Event{Kind: 1, CreatedAt: nostr.Now(), Tags: nostr.Tags{}, Content: "Initially unavailable note"}
	if err := note.Sign(nostr.GeneratePrivateKey()); err != nil {
		t.Fatal(err)
	}
	zapper := nostr.GeneratePrivateKey()
	zapperPubkey, err := nostr.GetPublicKey(zapper)
	if err != nil {
		t.Fatal(err)
	}
	description := zapRequestJSON(t, nostr.GeneratePrivateKey(), nostr.Tags{{"p", testRelayPubkey}}, note.ID)
	receipt := &nostr.Event{Kind: 9735, CreatedAt: nostr.Now(), Tags: nostr.Tags{
		{"p", testRelayPubkey}, {"description", description}, {"bolt11", mintInvoice(t, 21000, description, &chaincfg.MainNetParams)},
	}}
	if err := receipt.Sign(zapper); err != nil {
		t.Fatal(err)
	}
	resolver := seedResolver(zapperPubkey)
	if _, err := ValidateZapReceipt(receipt, testRelayPubkey, resolver); err != nil {
		t.Fatal(err)
	}
	monitor := NewPaymentMonitor(storage, testRelayPubkey, NewPostFetcher(nil), resolver)
	if err := monitor.ProcessZap(context.Background(), receipt); err == nil {
		t.Fatal("expected temporary note fetch failure")
	}
	// The note becomes available after a separate promotion, and the receipt is replayed.
	if err := storage.AddPayment(note.ID, 1, note); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewStorage(storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	monitor = NewPaymentMonitor(reloaded, testRelayPubkey, NewPostFetcher(nil), resolver)
	if err := monitor.ProcessZap(context.Background(), receipt); err != nil {
		t.Fatal(err)
	}
	post, _ := reloaded.GetPost(note.ID)
	if post.TotalSatsPaid != 22 {
		t.Fatalf("valid zap never credited on replay: total=%d, want 22", post.TotalSatsPaid)
	}
}

func TestLegacyZapBoostKeepsExistingWeight(t *testing.T) {
	storage, _, _, id := billboardFixture(t)
	storage.mu.Lock()
	post := storage.posts[id]
	post.Payments = nil
	post.TotalSatsPaid = 200
	post.LastPaymentTimestamp = time.Now().Add(-rankHalfLife)
	err := storage.save()
	storage.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewStorage(storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := reloaded.GetPost(id)
	if err := reloaded.AddPayment(id, 1, nil); err != nil {
		t.Fatal(err)
	}
	after, _ := reloaded.GetPost(id)
	if after.weight(time.Now()) != before.weight(time.Now())+1 {
		t.Fatalf("boost discarded legacy weight: before=%d, after=%d", before.weight(time.Now()), after.weight(time.Now()))
	}
}

func recoverableZap(t *testing.T) (*Storage, *PaymentMonitor, *nostr.Event, *nostr.Event, string) {
	t.Helper()
	storage := newTestStorage(t)
	note := &nostr.Event{Kind: 1, CreatedAt: nostr.Now(), Tags: nostr.Tags{}, Content: "Recovery test note"}
	if err := note.Sign(nostr.GeneratePrivateKey()); err != nil {
		t.Fatal(err)
	}
	if err := storage.AddPayment(note.ID, 1, note); err != nil {
		t.Fatal(err)
	}
	key := nostr.GeneratePrivateKey()
	pubkey, _ := nostr.GetPublicKey(key)
	description := zapRequestJSON(t, nostr.GeneratePrivateKey(), relayPTag(), note.ID)
	receipt := &nostr.Event{Kind: 9735, CreatedAt: nostr.Now(), Tags: nostr.Tags{
		{"p", testRelayPubkey}, {"description", description},
		{"bolt11", mintInvoice(t, 21000, description, &chaincfg.MainNetParams)},
	}}
	if err := receipt.Sign(key); err != nil {
		t.Fatal(err)
	}
	return storage, NewPaymentMonitor(storage, testRelayPubkey, NewPostFetcher(nil), seedResolver(pubkey)), note, receipt, key
}

func TestZapSaveFailureCanRetryWithoutDuplicateCredit(t *testing.T) {
	storage, monitor, note, receipt, _ := recoverableZap(t)
	details, err := ValidateZapReceipt(receipt, testRelayPubkey, monitor.zapValidator)
	if err != nil {
		t.Fatal(err)
	}
	path := storage.dataFile
	storage.dataFile = filepath.Join(t.TempDir(), "missing", "board.json")
	if err := monitor.ProcessZap(context.Background(), receipt); err == nil {
		t.Fatal("expected save failure")
	}
	post, _ := storage.GetPost(note.ID)
	if post.TotalSatsPaid != 1 || len(post.Payments) != 1 || storage.IsZapProcessed(receipt.ID) {
		t.Fatal("failed save changed credit or deduplication marker")
	}
	if _, ok := storage.InvoiceReceipt(details.PaymentHash); ok {
		t.Fatal("failed save left receipt")
	}
	storage.dataFile = path
	if err := monitor.ProcessZap(context.Background(), receipt); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewStorage(path)
	if err != nil {
		t.Fatal(err)
	}
	monitor = NewPaymentMonitor(reloaded, testRelayPubkey, NewPostFetcher(nil), monitor.zapValidator)
	if err := monitor.ProcessZap(context.Background(), receipt); err != nil {
		t.Fatal(err)
	}
	post, _ = reloaded.GetPost(note.ID)
	if post.TotalSatsPaid != 22 || !reloaded.IsZapProcessed(receipt.ID) {
		t.Fatal("retry did not credit exactly once")
	}
}

func TestConcurrentZapReceiptsCreditSamePaymentOnce(t *testing.T) {
	storage, monitor, note, receipt, key := recoverableZap(t)
	other := *receipt
	other.Tags = append(append(nostr.Tags(nil), receipt.Tags...), nostr.Tag{"alt", "second receipt"})
	if err := other.Sign(key); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errors := make(chan error, 16)
	for i := 0; i < cap(errors); i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			zap := receipt
			if i%2 == 1 {
				zap = &other
			}
			errors <- monitor.ProcessZap(context.Background(), zap)
		}(i)
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	reloaded, err := NewStorage(storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	post, _ := reloaded.GetPost(note.ID)
	if post.TotalSatsPaid != 22 || len(post.Payments) != 2 {
		t.Fatal("concurrent receipts duplicated credit")
	}
}

func TestAddPaymentSaveFailureKeepsOriginalHistoryAndAppearance(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(fmt.Sprint(existing), func(t *testing.T) {
			storage, _, _, id := billboardFixture(t)
			storage.posts[id].Billboard = testBillboard(storage.posts[id].Event.Content)
			expireBillboardPost(storage, id)
			original, _ := storage.GetPost(id)
			if !existing {
				delete(storage.posts, id)
			}
			path := storage.dataFile
			storage.dataFile = filepath.Join(t.TempDir(), "missing", "board.json")
			if err := storage.AddPayment(id, 21, original.Event); err == nil {
				t.Fatal("expected save failure")
			}
			post, ok := storage.GetPost(id)
			if ok != existing {
				t.Fatal("failed payment changed post presence")
			}
			if existing && (post.TotalSatsPaid != original.TotalSatsPaid || len(post.Payments) != len(original.Payments) || post.Billboard == nil || post.ActivityID != original.ActivityID) {
				t.Fatal("failed payment changed existing history")
			}
			storage.dataFile = path
			if err := storage.AddPayment(id, 21, original.Event); err != nil {
				t.Fatal(err)
			}
			post, _ = storage.GetPost(id)
			want := int64(21)
			if existing {
				want += original.TotalSatsPaid
			}
			if post.Billboard != nil {
				t.Fatal("successful revival kept expired appearance")
			}
			if post.TotalSatsPaid != want {
				t.Fatalf("retry total=%d, want %d", post.TotalSatsPaid, want)
			}
		})
	}
}

func TestInvalidZapRemainsUnprocessed(t *testing.T) {
	storage, monitor, _, receipt, key := recoverableZap(t)
	for i, tag := range receipt.Tags {
		if tag[0] == "bolt11" {
			receipt.Tags[i] = nostr.Tag{"bolt11", "invalid"}
		}
	}
	if err := receipt.Sign(key); err != nil {
		t.Fatal(err)
	}
	if err := monitor.ProcessZap(context.Background(), receipt); err == nil {
		t.Fatal("expected validation failure")
	}
	if storage.IsZapProcessed(receipt.ID) {
		t.Fatal("invalid zap marked as processed")
	}
}

func TestZapAndWalletNotificationShareInvoiceAllocation(t *testing.T) {
	storage, monitor, note, receipt, _ := recoverableZap(t)
	details, err := ValidateZapReceipt(receipt, testRelayPubkey, monitor.zapValidator)
	if err != nil {
		t.Fatal(err)
	}
	config := testBillboard(note.Content)
	expireBillboardPost(storage, note.ID)
	invoice := &PendingInvoice{PostID: note.ID, Event: note, PaymentHash: details.PaymentHash,
		Invoice: firstTag(receipt, "bolt11"), AmountSats: 21, BillboardFee: 10, Billboard: config,
		CreatedAt: time.Now().Add(-2 * time.Hour), ExpiresAt: time.Now().Add(-time.Hour)}
	if err := storage.AddPendingInvoice(invoice); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errors := make(chan error, 16)
	for i := 0; i < cap(errors); i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if i%2 == 0 {
				errors <- monitor.ProcessInvoicePayment(details.PaymentHash, 999)
			} else {
				errors <- monitor.ProcessZap(context.Background(), receipt)
			}
		}(i)
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	reloaded, err := NewStorage(storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	post, _ := reloaded.GetPost(note.ID)
	result, ok := reloaded.InvoiceReceipt(details.PaymentHash)
	if !ok || !result.BillboardApplied || result.PromotionSats != 11 || result.BillboardFee != 10 || post.Billboard == nil || post.TotalSatsPaid != 12 {
		t.Fatal("zap and notification did not preserve stored invoice allocation exactly once")
	}
}

func TestExpiredBillboardInvoiceRetriesAfterDiskFailure(t *testing.T) {
	storage, manager, monitor, id := billboardFixture(t)
	expireBillboardPost(storage, id)
	post, _ := storage.GetPost(id)
	invoice, err := manager.GenerateBillboardInvoice(context.Background(), id, 21, nil, "", testBillboard(post.Event.Content), false, post.Event)
	if err != nil {
		t.Fatal(err)
	}
	storage.pendingInvoices[invoice.PaymentHash].ExpiresAt = time.Now().Add(-time.Hour)
	if err := storage.save(); err != nil {
		t.Fatal(err)
	}
	path := storage.dataFile
	storage.dataFile = filepath.Join(t.TempDir(), "missing", "board.json")
	if err := monitor.ProcessInvoicePayment(invoice.PaymentHash, 121); err == nil {
		t.Fatal("expected save failure")
	}
	reloaded, err := NewStorage(path)
	if err != nil {
		t.Fatal(err)
	}
	monitor = NewPaymentMonitor(reloaded, testRelayPubkey, NewPostFetcher(nil), seedResolver())
	if err := monitor.ProcessInvoicePayment(invoice.PaymentHash, 121); err != nil {
		t.Fatal(err)
	}
	result, ok := reloaded.InvoiceReceipt(invoice.PaymentHash)
	if !ok || !result.BillboardApplied || result.PromotionSats != 21 || result.BillboardFee != 100 {
		t.Fatal("expired allocation lost after failed write")
	}
}
