package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

func notificationFixture(t *testing.T) (*DMMonitor, *PaymentMonitor, *Storage, string, string, string, *[]*nostr.Event) {
	t.Helper()
	storage := newTestStorage(t)
	relayPrivkey := nostr.GeneratePrivateKey()
	relayPubkey, _ := nostr.GetPublicKey(relayPrivkey)
	monitor := NewPaymentMonitor(storage, relayPubkey, NewPostFetcher(nil), seedResolver())
	invoices := NewInvoiceManager(NewMockLightningBackend(), storage, monitor, 1000)
	dm := NewDMMonitor(nil, relayPubkey, relayPrivkey, invoices, storage)

	note := &nostr.Event{Kind: 1, CreatedAt: nostr.Now(), Tags: nostr.Tags{}, Content: "promote me"}
	if err := note.Sign(nostr.GeneratePrivateKey()); err != nil {
		t.Fatal(err)
	}
	if err := storage.AddPayment(note.ID, 1, note); err != nil {
		t.Fatal(err)
	}

	recipientPrivkey := nostr.GeneratePrivateKey()
	recipientPubkey, _ := nostr.GetPublicKey(recipientPrivkey)
	dm.lookupInbox = func(context.Context, string, []string) []string {
		return []string{"wss://recipient-inbox.example"}
	}
	published := []*nostr.Event{}
	dm.publishEvent = func(_ context.Context, _ string, event *nostr.Event) error {
		published = append(published, cloneNostrEvent(event))
		return nil
	}
	return dm, monitor, storage, note.ID, recipientPrivkey, recipientPubkey, &published
}

func unwrapTexts(t *testing.T, events []*nostr.Event, recipientPrivkey string) []*nostr.Event {
	t.Helper()
	messages := make([]*nostr.Event, 0, len(events))
	for _, event := range events {
		message, err := unwrapGiftWrap(event, recipientPrivkey)
		if err != nil {
			t.Fatalf("failed to unwrap published DM: %v", err)
		}
		messages = append(messages, message)
	}
	return messages
}

func TestPromoteOverNIP17QueuesOneInvoiceAndDecryptableReply(t *testing.T) {
	dm, _, storage, noteID, recipientPrivkey, recipientPubkey, published := notificationFixture(t)

	if err := dm.handleCommandEvent(context.Background(), recipientPubkey,
		"PROMOTE 21 "+noteID, "request-rumor", true, "source-wrap"); err != nil {
		t.Fatal(err)
	}
	if err := dm.handleCommandEvent(context.Background(), recipientPubkey,
		"PROMOTE 21 "+noteID, "request-rumor", true, "source-wrap"); err != nil {
		t.Fatal(err)
	}
	if pending := storage.ListPendingInvoices(); len(pending) != 1 {
		t.Fatalf("pending invoices=%d, want one idempotent invoice", len(pending))
	}

	dm.publishPendingDMs(context.Background())
	if len(*published) != 1 {
		t.Fatalf("published replies=%d, want one", len(*published))
	}
	reply := unwrapTexts(t, *published, recipientPrivkey)[0]
	if reply.Kind != kindChatMessage || firstTag(reply, "e") != "request-rumor" {
		t.Fatalf("reply kind=%d tags=%v", reply.Kind, reply.Tags)
	}
	if !strings.Contains(reply.Content, "lightning:lnbc21") || !strings.Contains(reply.Content, "21 sats") {
		t.Fatalf("unexpected invoice reply: %s", reply.Content)
	}
}

func TestConfirmedNotificationFiresOnceWhenActivityExpires(t *testing.T) {
	dm, monitor, storage, noteID, recipientPrivkey, recipientPubkey, published := notificationFixture(t)
	if err := dm.handleCommandEvent(context.Background(), recipientPubkey,
		"PROMOTE 21 "+noteID, "request-rumor", true, "source-wrap"); err != nil {
		t.Fatal(err)
	}
	invoice := storage.ListPendingInvoices()[0]
	if err := monitor.ProcessInvoicePayment(invoice.PaymentHash, invoice.AmountSats); err != nil {
		t.Fatal(err)
	}
	if len(storage.notifications) != 1 {
		t.Fatalf("notifications=%d, want one offer", len(storage.notifications))
	}

	if err := storage.queueNotificationMessages(time.Now(), false); err != nil {
		t.Fatal(err)
	}
	dm.publishPendingDMs(context.Background())
	messages := unwrapTexts(t, *published, recipientPrivkey)
	var prompt *nostr.Event
	for _, message := range messages {
		if strings.Contains(message.Content, "Reply YES") {
			prompt = message
		}
	}
	if prompt == nil {
		t.Fatal("activation prompt was not delivered")
	}

	if err := dm.handleCommand(context.Background(), recipientPubkey, "YES", prompt.ID, true); err != nil {
		t.Fatal(err)
	}
	for _, notification := range storage.notifications {
		if notification.State != notificationConfirmed {
			t.Fatalf("notification state=%q, want confirmed", notification.State)
		}
	}

	expireBillboardPost(storage, noteID)
	if err := storage.queueNotificationMessages(time.Now(), true); err != nil {
		t.Fatal(err)
	}
	dm.publishPendingDMs(context.Background())
	messages = unwrapTexts(t, *published, recipientPrivkey)
	expired := 0
	for _, message := range messages {
		if strings.Contains(message.Content, "moved to Expired") {
			expired++
		}
	}
	if expired != 1 {
		t.Fatalf("expiry messages=%d, want one", expired)
	}
	if len(storage.notifications) != 0 {
		t.Fatal("delivered notification was not consumed")
	}
	if err := storage.queueNotificationMessages(time.Now(), true); err != nil {
		t.Fatal(err)
	}
	dm.publishPendingDMs(context.Background())
	messages = unwrapTexts(t, *published, recipientPrivkey)
	secondCount := 0
	for _, message := range messages {
		if strings.Contains(message.Content, "moved to Expired") {
			secondCount++
		}
	}
	if secondCount != 1 {
		t.Fatalf("expiry notification repeated: %d deliveries", secondCount)
	}
}

func TestUnconfirmedOfferIsDroppedAtExpiry(t *testing.T) {
	_, monitor, storage, noteID, _, recipientPubkey, _ := notificationFixture(t)
	post, _ := storage.GetPost(noteID)
	invoice := &PendingInvoice{
		PostID: noteID, Invoice: "lnbc21", PaymentHash: "notify-unconfirmed", AmountSats: 21,
		CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour), Event: post.Event,
		Contact: &PromotionContact{Pubkey: recipientPubkey, Transport: dmTransportNIP17},
	}
	if err := storage.AddPendingInvoice(invoice); err != nil {
		t.Fatal(err)
	}
	if err := monitor.ProcessInvoicePayment(invoice.PaymentHash, invoice.AmountSats); err != nil {
		t.Fatal(err)
	}
	for _, notification := range storage.notifications {
		notification.State = notificationAwaitingYes
	}
	expireBillboardPost(storage, noteID)
	if err := storage.queueNotificationMessages(time.Now(), true); err != nil {
		t.Fatal(err)
	}
	if len(storage.notifications) != 0 {
		t.Fatal("unconfirmed notification survived expiry")
	}
	for _, message := range storage.dmOutbox {
		if message.Purpose == outboundExpiry {
			t.Fatal("unconfirmed recipient received an expiry message")
		}
	}
}

func TestDMOutboxSurvivesRestartAndRetriesOnlyMissingRelays(t *testing.T) {
	storage := newTestStorage(t)
	relayPrivkey := nostr.GeneratePrivateKey()
	relayPubkey, _ := nostr.GetPublicKey(relayPrivkey)
	recipientPrivkey := nostr.GeneratePrivateKey()
	recipientPubkey, _ := nostr.GetPublicKey(recipientPrivkey)
	monitor := NewPaymentMonitor(storage, relayPubkey, NewPostFetcher(nil), seedResolver())
	dm := NewDMMonitor(nil, relayPubkey, relayPrivkey,
		NewInvoiceManager(NewMockLightningBackend(), storage, monitor, 1000), storage)
	dm.lookupInbox = func(context.Context, string, []string) []string {
		return []string{"wss://one.example", "wss://two.example"}
	}

	if err := dm.reply(context.Background(), recipientPubkey, "durable", "", true); err != nil {
		t.Fatal(err)
	}
	var firstID string
	dm.publishEvent = func(_ context.Context, relay string, event *nostr.Event) error {
		if firstID == "" {
			firstID = event.ID
		} else if event.ID != firstID {
			t.Fatalf("retry changed event ID from %s to %s", firstID, event.ID)
		}
		if relay == "wss://two.example" {
			return errors.New("temporarily unavailable")
		}
		return nil
	}
	dm.publishPendingDMs(context.Background())
	if len(storage.dmOutbox) != 1 {
		t.Fatalf("outbox entries=%d, want one partial delivery", len(storage.dmOutbox))
	}

	reloaded, err := NewStorage(storage.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	monitor = NewPaymentMonitor(reloaded, relayPubkey, NewPostFetcher(nil), seedResolver())
	dm = NewDMMonitor(nil, relayPubkey, relayPrivkey,
		NewInvoiceManager(NewMockLightningBackend(), reloaded, monitor, 1000), reloaded)
	called := []string{}
	dm.publishEvent = func(_ context.Context, relay string, event *nostr.Event) error {
		called = append(called, relay)
		if event.ID != firstID {
			t.Fatalf("restart changed event ID from %s to %s", firstID, event.ID)
		}
		return nil
	}
	dm.publishPendingDMs(context.Background())
	if len(called) != 1 || called[0] != "wss://two.example" {
		t.Fatalf("retried relays=%v, want only the missing relay", called)
	}
	if len(reloaded.dmOutbox) != 0 {
		t.Fatal("fully delivered message remained in the outbox")
	}
}
