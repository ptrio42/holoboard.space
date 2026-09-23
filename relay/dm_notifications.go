package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sort"
	"sync"
	"time"

	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip04"
	"github.com/nbd-wtf/go-nostr/nip19"
)

const (
	dmTransportNIP04 = "nip04"
	dmTransportNIP17 = "nip17"

	notificationOfferPending  = "offer_pending"
	notificationAwaitingYes   = "awaiting_yes"
	notificationConfirmed     = "confirmed"
	notificationExpiryPending = "expiry_pending"

	outboundOffer        = "offer"
	outboundExpiry       = "expiry"
	outboundInvoice      = "invoice"
	outboundConfirmation = "confirmation"

	maxQueuedDMReplies           = 100
	maxQueuedRepliesPerRecipient = 3
	outboundReplyLifetime        = 24 * time.Hour
	outboxWorkers                = 8
)

var errDMReplyQueueFull = errors.New("DM reply queue is full")

// PromotionContact says who may opt into one expiry notification after a
// payment settles. It is private relay state and is never exposed by an API.
type PromotionContact struct {
	Pubkey    string `json:"pubkey"`
	Transport string `json:"transport"`
	ReplyTo   string `json:"reply_to,omitempty"`
}

// PromotionNotification follows one continuous active period. ActivityID is
// replaced when an expired note is promoted again, so consent never leaks into
// a later promotion cycle.
type PromotionNotification struct {
	Key        string    `json:"key"`
	PostID     string    `json:"post_id"`
	ActivityID string    `json:"activity_id"`
	Recipient  string    `json:"recipient"`
	Transport  string    `json:"transport"`
	ReplyTo    string    `json:"reply_to,omitempty"`
	State      string    `json:"state"`
	PromptID   string    `json:"prompt_id,omitempty"`
	AmountSats int64     `json:"amount_sats"`
	CreatedAt  time.Time `json:"created_at"`
}

// OutboundDM is a durable delivery intent. Event is filled only after a NIP-17
// inbox has been found. Once filled, retries reuse the same signed event ID.
type OutboundDM struct {
	Key             string       `json:"key"`
	Recipient       string       `json:"recipient"`
	Transport       string       `json:"transport"`
	ReplyTo         string       `json:"reply_to,omitempty"`
	Content         string       `json:"content"`
	Purpose         string       `json:"purpose,omitempty"`
	NotificationKey string       `json:"notification_key,omitempty"`
	Event           *nostr.Event `json:"event,omitempty"`
	MessageID       string       `json:"message_id,omitempty"`
	Targets         []string     `json:"targets,omitempty"`
	Delivered       []string     `json:"delivered,omitempty"`
	SenderEvent     *nostr.Event `json:"sender_event,omitempty"`
	SenderTargets   []string     `json:"sender_targets,omitempty"`
	SenderDelivered []string     `json:"sender_delivered,omitempty"`
	CreatedAt       time.Time    `json:"created_at"`
	NextAttemptAt   time.Time    `json:"next_attempt_at,omitempty"`
}

func notificationKey(postID, activityID, recipient string) string {
	return postID + ":" + activityID + ":" + recipient
}

func cloneOutboundDM(message *OutboundDM) *OutboundDM {
	if message == nil {
		return nil
	}
	clone := *message
	clone.Event = cloneNostrEvent(message.Event)
	clone.Targets = append([]string(nil), message.Targets...)
	clone.Delivered = append([]string(nil), message.Delivered...)
	clone.SenderEvent = cloneNostrEvent(message.SenderEvent)
	clone.SenderTargets = append([]string(nil), message.SenderTargets...)
	clone.SenderDelivered = append([]string(nil), message.SenderDelivered...)
	return &clone
}

func clonePromotionNotification(notification *PromotionNotification) *PromotionNotification {
	if notification == nil {
		return nil
	}
	clone := *notification
	return &clone
}

func cloneNotificationMap(source map[string]*PromotionNotification) map[string]*PromotionNotification {
	clone := make(map[string]*PromotionNotification, len(source))
	for key, notification := range source {
		clone[key] = clonePromotionNotification(notification)
	}
	return clone
}

func cloneDMOutbox(source map[string]*OutboundDM) map[string]*OutboundDM {
	clone := make(map[string]*OutboundDM, len(source))
	for key, message := range source {
		clone[key] = cloneOutboundDM(message)
	}
	return clone
}

func newPromotionNotification(post *PromotedPost, contact *PromotionContact, amount int64) *PromotionNotification {
	if post == nil || contact == nil || contact.Pubkey == "" {
		return nil
	}
	key := notificationKey(post.PostID, post.ActivityID, contact.Pubkey)
	return &PromotionNotification{
		Key: key, PostID: post.PostID, ActivityID: post.ActivityID,
		Recipient: contact.Pubkey, Transport: contact.Transport, ReplyTo: contact.ReplyTo,
		State: notificationOfferPending, AmountSats: amount, CreatedAt: time.Now(),
	}
}

func noteReference(id string) string {
	note, err := nip19.EncodeNote(id)
	if err != nil {
		return id
	}
	return "nostr:" + note
}

func activePromotionMessage(notification *PromotionNotification) string {
	return fmt.Sprintf(`Your Holoboard promotion is active.

%s

Reply YES to this message if you want one DM when it moves to Expired. This consent applies only to the current active period.

If your client loses the reply context, send: NOTIFY %s`,
		noteReference(notification.PostID), noteReference(notification.PostID))
}

func expiredPromotionMessage(notification *PromotionNotification) string {
	return fmt.Sprintf(`Your Holoboard promotion has expired and moved to Expired.

%s

Promote it again by sending:
PROMOTE %s

https://holoboard.space/expired`, noteReference(notification.PostID), noteReference(notification.PostID))
}

// queueNotificationMessages materializes durable messages from durable state.
// Expiry checks are delayed for the first minute after startup so invoice
// reconciliation gets the first chance to revive a paid note.
func (s *Storage) queueNotificationMessages(now time.Time, includeExpiry bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	originalNotifications := cloneNotificationMap(s.notifications)
	originalOutbox := cloneDMOutbox(s.dmOutbox)
	changed := false
	for key, notification := range s.notifications {
		post := s.posts[notification.PostID]
		if post == nil || s.removed[notification.PostID] || post.ActivityID != notification.ActivityID {
			delete(s.notifications, key)
			delete(s.dmOutbox, "offer:"+key)
			delete(s.dmOutbox, "expired:"+key)
			changed = true
			continue
		}

		switch notification.State {
		case notificationOfferPending:
			if post.weight(now) == 0 {
				delete(s.notifications, key)
				delete(s.dmOutbox, "offer:"+key)
				changed = true
				continue
			}
			outboxKey := "offer:" + key
			if s.dmOutbox[outboxKey] == nil {
				s.dmOutbox[outboxKey] = &OutboundDM{
					Key: outboxKey, Recipient: notification.Recipient, Transport: notification.Transport,
					ReplyTo: notification.ReplyTo, Content: activePromotionMessage(notification),
					Purpose: outboundOffer, NotificationKey: key, CreatedAt: now,
				}
				changed = true
			}
		case notificationAwaitingYes:
			if post.weight(now) == 0 {
				delete(s.notifications, key)
				delete(s.dmOutbox, "offer:"+key)
				changed = true
			}
		case notificationConfirmed:
			if includeExpiry && post.weight(now) == 0 {
				delete(s.dmOutbox, "offer:"+key)
				outboxKey := "expired:" + key
				if s.dmOutbox[outboxKey] == nil {
					s.dmOutbox[outboxKey] = &OutboundDM{
						Key: outboxKey, Recipient: notification.Recipient, Transport: notification.Transport,
						Content: expiredPromotionMessage(notification), Purpose: outboundExpiry,
						NotificationKey: key, CreatedAt: now,
					}
					notification.State = notificationExpiryPending
					changed = true
				}
			}
		}
	}
	if !changed {
		return nil
	}
	if err := s.save(); err != nil {
		s.notifications = originalNotifications
		s.dmOutbox = originalOutbox
		return err
	}
	return nil
}

func (s *Storage) queueOutboundDM(message *OutboundDM) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.dmOutbox[message.Key]; exists {
		return nil
	}
	if message.Purpose == "" {
		count, recipientCount := 0, 0
		for _, queued := range s.dmOutbox {
			if queued.Purpose != "" {
				continue
			}
			count++
			if queued.Recipient == message.Recipient {
				recipientCount++
			}
		}
		if count >= maxQueuedDMReplies || recipientCount >= maxQueuedRepliesPerRecipient {
			return errDMReplyQueueFull
		}
	}
	s.dmOutbox[message.Key] = cloneOutboundDM(message)
	if err := s.save(); err != nil {
		delete(s.dmOutbox, message.Key)
		return err
	}
	return nil
}

func (s *Storage) pruneExpiredDMReplies(now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	originalOutbox := cloneDMOutbox(s.dmOutbox)
	for key, message := range s.dmOutbox {
		if (message.Purpose == "" || message.Purpose == outboundInvoice || message.Purpose == outboundConfirmation) &&
			!message.CreatedAt.IsZero() && now.Sub(message.CreatedAt) > outboundReplyLifetime {
			delete(s.dmOutbox, key)
		}
	}
	if len(originalOutbox) == len(s.dmOutbox) {
		return nil
	}
	if err := s.save(); err != nil {
		s.dmOutbox = originalOutbox
		return err
	}
	return nil
}

func (s *Storage) pendingOutboundDMs() []*OutboundDM {
	s.mu.RLock()
	defer s.mu.RUnlock()
	messages := make([]*OutboundDM, 0, len(s.dmOutbox))
	now := time.Now()
	for _, message := range s.dmOutbox {
		if !message.NextAttemptAt.After(now) {
			messages = append(messages, cloneOutboundDM(message))
		}
	}
	sort.Slice(messages, func(i, j int) bool {
		priority := func(message *OutboundDM) int {
			if message.Event != nil {
				return 0
			}
			if message.Purpose == outboundOffer || message.Purpose == outboundExpiry {
				return 1
			}
			if message.Purpose == outboundInvoice || message.Purpose == outboundConfirmation {
				return 2
			}
			return 3
		}
		left, right := priority(messages[i]), priority(messages[j])
		if left != right {
			return left < right
		}
		if !messages[i].CreatedAt.Equal(messages[j].CreatedAt) {
			return messages[i].CreatedAt.Before(messages[j].CreatedAt)
		}
		return messages[i].Key < messages[j].Key
	})
	return messages
}

func (s *Storage) deferOutboundDMLookup(key string, next time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	message := s.dmOutbox[key]
	if message == nil || message.Event != nil {
		return nil
	}
	previous := message.NextAttemptAt
	message.NextAttemptAt = next
	if err := s.save(); err != nil {
		message.NextAttemptAt = previous
		return err
	}
	return nil
}

func (s *Storage) prepareOutboundDM(key string, event, senderEvent *nostr.Event, messageID string, targets, senderTargets []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	message := s.dmOutbox[key]
	if message == nil || message.Event != nil {
		return nil
	}
	message.Event = cloneNostrEvent(event)
	message.MessageID = messageID
	message.Targets = dedupe(append([]string(nil), targets...))
	message.SenderEvent = cloneNostrEvent(senderEvent)
	message.SenderTargets = dedupe(append([]string(nil), senderTargets...))
	if err := s.save(); err != nil {
		message.Event = nil
		message.MessageID = ""
		message.Targets = nil
		message.Delivered = nil
		message.SenderEvent = nil
		message.SenderTargets = nil
		message.SenderDelivered = nil
		return err
	}
	return nil
}

func (s *Storage) markOutboundDMDelivered(key, eventID string, accepted []string, senderCopy bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	message := s.dmOutbox[key]
	if message == nil || len(accepted) == 0 {
		return nil
	}
	if senderCopy {
		if message.SenderEvent == nil || message.SenderEvent.ID != eventID {
			return nil
		}
	} else if message.Event == nil || message.Event.ID != eventID {
		return nil
	}
	originalNotifications := cloneNotificationMap(s.notifications)
	originalOutbox := cloneDMOutbox(s.dmOutbox)
	firstDelivery := !senderCopy && len(message.Delivered) == 0
	if senderCopy {
		message.SenderDelivered = dedupe(append(message.SenderDelivered, accepted...))
	} else {
		message.Delivered = dedupe(append(message.Delivered, accepted...))
	}
	if firstDelivery && message.NotificationKey != "" {
		notification := s.notifications[message.NotificationKey]
		if notification != nil {
			switch message.Purpose {
			case outboundOffer:
				notification.State = notificationAwaitingYes
				notification.PromptID = message.MessageID
			case outboundExpiry:
				delete(s.notifications, message.NotificationKey)
			}
		}
	}
	if containsAll(message.Delivered, message.Targets) && containsAll(message.SenderDelivered, message.SenderTargets) {
		delete(s.dmOutbox, key)
	}
	if err := s.save(); err != nil {
		s.notifications = originalNotifications
		s.dmOutbox = originalOutbox
		return err
	}
	return nil
}

func containsAll(values, wanted []string) bool {
	present := make(map[string]bool, len(values))
	for _, value := range values {
		present[value] = true
	}
	for _, value := range wanted {
		if !present[value] {
			return false
		}
	}
	return true
}

// confirmNotification accepts a threaded YES, or an explicit NOTIFY command.
func (s *Storage) confirmNotification(sender, replyTo, noteID string) (*PromotionNotification, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var matches []*PromotionNotification
	for _, notification := range s.notifications {
		if notification.Recipient != sender || notification.State != notificationAwaitingYes {
			continue
		}
		if replyTo != "" && notification.PromptID == replyTo {
			matches = []*PromotionNotification{notification}
			break
		}
		if noteID != "" && notification.PostID == noteID {
			matches = append(matches, notification)
			continue
		}
		if replyTo == "" && noteID == "" {
			matches = append(matches, notification)
		}
	}
	if len(matches) != 1 {
		return nil, fmt.Errorf("I could not match that confirmation. Reply YES to the activation message, or send NOTIFY <note id>.")
	}
	originalOutbox := cloneDMOutbox(s.dmOutbox)
	matches[0].State = notificationConfirmed
	delete(s.dmOutbox, "offer:"+matches[0].Key)
	if err := s.save(); err != nil {
		matches[0].State = notificationAwaitingYes
		s.dmOutbox = originalOutbox
		return nil, err
	}
	return clonePromotionNotification(matches[0]), nil
}

func (dm *DMMonitor) Wake() {
	select {
	case dm.wake <- struct{}{}:
	default:
	}
}

func (dm *DMMonitor) runOutbox(ctx context.Context) {
	retry := time.NewTicker(30 * time.Second)
	expiry := time.NewTicker(time.Minute)
	defer retry.Stop()
	defer expiry.Stop()

	_ = dm.storage.queueNotificationMessages(time.Now(), false)
	dm.publishPendingDMs(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-dm.wake:
			_ = dm.storage.queueNotificationMessages(time.Now(), false)
			dm.publishPendingDMs(ctx)
		case <-retry.C:
			dm.publishPendingDMs(ctx)
		case now := <-expiry.C:
			if err := dm.storage.queueNotificationMessages(now, true); err != nil {
				log.Printf("Failed to queue DM notifications: %v", err)
			}
			dm.publishPendingDMs(ctx)
		}
	}
}

func (dm *DMMonitor) publishPendingDMs(ctx context.Context) {
	dm.outboxMu.Lock()
	defer dm.outboxMu.Unlock()
	if err := dm.storage.pruneExpiredDMReplies(time.Now()); err != nil {
		log.Printf("Failed to prune expired DM replies: %v", err)
	}
	jobs := make(chan *OutboundDM)
	var workers sync.WaitGroup
	for i := 0; i < outboxWorkers; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for message := range jobs {
				dm.publishPendingDM(ctx, message)
			}
		}()
	}
	for _, message := range dm.storage.pendingOutboundDMs() {
		if ctx.Err() != nil {
			break
		}
		jobs <- message
	}
	close(jobs)
	workers.Wait()
}

func (dm *DMMonitor) publishPendingDM(ctx context.Context, message *OutboundDM) {
	if ctx.Err() != nil {
		return
	}
	if message.Event == nil {
		targets := dm.relays
		var event *nostr.Event
		var senderEvent *nostr.Event
		var messageID string
		var err error
		if message.Transport == dmTransportNIP17 {
			targets = dm.lookupInbox(ctx, message.Recipient, dm.relays)
			if len(targets) == 0 {
				if err := dm.storage.deferOutboundDMLookup(message.Key, time.Now().Add(10*time.Minute)); err != nil {
					log.Printf("Failed to defer DM inbox lookup %s: %v", message.Key, err)
				}
				return
			}
			event, senderEvent, messageID, err = wrapMessageCopies(message.Content, message.Recipient, dm.relayPrivkey, message.ReplyTo)
		} else {
			event, err = legacyDM(message.Content, message.Recipient, dm.relayPubkey, dm.relayPrivkey)
			if event != nil {
				messageID = event.ID
			}
		}
		if err != nil {
			log.Printf("Failed to build queued DM %s: %v", message.Key, err)
			return
		}
		senderTargets := []string(nil)
		if senderEvent != nil {
			senderTargets = dm.senderRelays
		}
		if err := dm.storage.prepareOutboundDM(message.Key, event, senderEvent, messageID, targets, senderTargets); err != nil {
			log.Printf("Failed to persist queued DM %s: %v", message.Key, err)
			return
		}
		message.Event, message.MessageID, message.Targets = event, messageID, targets
		message.SenderEvent, message.SenderTargets = senderEvent, senderTargets
	}

	alreadyDelivered := make(map[string]bool, len(message.Delivered))
	for _, target := range message.Delivered {
		alreadyDelivered[target] = true
	}
	accepted := make([]string, 0, len(message.Targets))
	for _, target := range message.Targets {
		if alreadyDelivered[target] {
			continue
		}
		if err := dm.publishTo(ctx, target, message.Event); err != nil {
			log.Printf("Failed to publish queued DM %s to %s: %v", message.Key, target, err)
			continue
		}
		accepted = append(accepted, target)
	}
	if len(accepted) > 0 {
		if err := dm.storage.markOutboundDMDelivered(message.Key, message.Event.ID, accepted, false); err != nil {
			log.Printf("Failed to record queued DM %s delivery: %v", message.Key, err)
		}
	}

	alreadySenderDelivered := make(map[string]bool, len(message.SenderDelivered))
	for _, target := range message.SenderDelivered {
		alreadySenderDelivered[target] = true
	}
	senderAccepted := make([]string, 0, len(message.SenderTargets))
	for _, target := range message.SenderTargets {
		if alreadySenderDelivered[target] {
			continue
		}
		if err := dm.publishTo(ctx, target, message.SenderEvent); err != nil {
			log.Printf("Failed to publish queued DM sender copy %s to %s: %v", message.Key, target, err)
			continue
		}
		senderAccepted = append(senderAccepted, target)
	}
	if len(senderAccepted) > 0 {
		if err := dm.storage.markOutboundDMDelivered(message.Key, message.SenderEvent.ID, senderAccepted, true); err != nil {
			log.Printf("Failed to record queued DM sender-copy delivery %s: %v", message.Key, err)
		}
	}
}

func legacyDM(content, recipient, senderPubkey, senderPrivkey string) (*nostr.Event, error) {
	sharedSecret, err := nip04SharedSecret(recipient, senderPrivkey)
	if err != nil {
		return nil, err
	}
	encrypted, err := nip04Encrypt(content, sharedSecret)
	if err != nil {
		return nil, err
	}
	event := &nostr.Event{
		PubKey: senderPubkey, CreatedAt: nostr.Now(), Kind: 4,
		Tags: nostr.Tags{{"p", recipient}}, Content: encrypted,
	}
	if err := event.Sign(senderPrivkey); err != nil {
		return nil, err
	}
	return event, nil
}

// Small wrappers keep encryption injectable at the file boundary and make the
// construction path shared with the existing synchronous code.
func nip04SharedSecret(pubkey, privkey string) ([]byte, error) {
	return nip04.ComputeSharedSecret(pubkey, privkey)
}

func nip04Encrypt(content string, secret []byte) (string, error) {
	return nip04.Encrypt(content, secret)
}
