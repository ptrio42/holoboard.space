package main

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip19"
)

const promotionQuoteCopy = "Paid promotion on Holoboard."

func quotePublicationKey(noteID string) string {
	return "quote:" + noteID
}

func deletionPublicationKey(eventID string) string {
	return "deletion:" + eventID
}

func newAccountPublication(kind, noteID string, event *nostr.Event, targets []string) *AccountPublication {
	return &AccountPublication{
		Type:    kind,
		NoteID:  noteID,
		Event:   cloneNostrEvent(event),
		Targets: dedupe(append([]string(nil), targets...)),
	}
}

func suppressedQuotePublication(noteID string) *AccountPublication {
	return &AccountPublication{
		Type:       accountPublicationQuote,
		NoteID:     noteID,
		Cancelled:  true,
		Suppressed: true,
	}
}

func cloneNostrEvent(event *nostr.Event) *nostr.Event {
	if event == nil {
		return nil
	}
	clone := *event
	clone.Tags = make(nostr.Tags, len(event.Tags))
	for i, tag := range event.Tags {
		clone.Tags[i] = append(nostr.Tag(nil), tag...)
	}
	return &clone
}

func cloneAccountPublication(publication *AccountPublication) *AccountPublication {
	if publication == nil {
		return nil
	}
	clone := *publication
	clone.Event = cloneNostrEvent(publication.Event)
	clone.Targets = append([]string(nil), publication.Targets...)
	clone.Delivered = append([]string(nil), publication.Delivered...)
	return &clone
}

func pendingRelayTargets(publication *AccountPublication) []string {
	delivered := make(map[string]bool, len(publication.Delivered))
	for _, relay := range publication.Delivered {
		delivered[relay] = true
	}
	pending := make([]string, 0, len(publication.Targets))
	for _, relay := range publication.Targets {
		if !delivered[relay] {
			pending = append(pending, relay)
		}
	}
	return pending
}

// PendingAccountPublication is a snapshot safe to use while network calls are
// in flight. Storage locks are never held while a relay is contacted.
type PendingAccountPublication struct {
	Key     string
	Record  *AccountPublication
	Pending []string
}

func (s *Storage) QuotePublication(noteID string) (*AccountPublication, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.accountPublications[quotePublicationKey(noteID)]
	if !ok {
		return nil, false
	}
	return cloneAccountPublication(record), true
}

func (s *Storage) PendingAccountPublications() []PendingAccountPublication {
	s.mu.RLock()
	defer s.mu.RUnlock()

	pending := make([]PendingAccountPublication, 0)
	for key, record := range s.accountPublications {
		if record == nil || record.Event == nil || record.Cancelled {
			continue
		}
		targets := pendingRelayTargets(record)
		if len(targets) == 0 {
			continue
		}
		pending = append(pending, PendingAccountPublication{
			Key:     key,
			Record:  cloneAccountPublication(record),
			Pending: targets,
		})
	}
	return pending
}

// MarkAccountPublicationDelivered records accepted relays as a batch. If a
// save fails, the whole batch is rolled back and the same event ID is retried.
func (s *Storage) MarkAccountPublicationDelivered(key, eventID string, relays []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	record, ok := s.accountPublications[key]
	if !ok || record == nil || record.Event == nil || record.Event.ID != eventID || record.Cancelled {
		return nil
	}
	original := record
	updated := cloneAccountPublication(record)
	delivered := make(map[string]bool, len(updated.Delivered)+len(relays))
	for _, relay := range updated.Delivered {
		delivered[relay] = true
	}
	changed := false
	for _, relay := range relays {
		if !delivered[relay] {
			updated.Delivered = append(updated.Delivered, relay)
			delivered[relay] = true
			changed = true
		}
	}
	if !changed {
		return nil
	}
	s.accountPublications[key] = updated
	if err := s.save(); err != nil {
		s.accountPublications[key] = original
		return fmt.Errorf("save account publication delivery: %w", err)
	}
	return nil
}

type accountPublishFunc func(context.Context, string, *nostr.Event) error

// AccountPublisher creates account events and drains their durable outbox.
type AccountPublisher struct {
	storage      *Storage
	relayPubkey  string
	relayPrivkey string
	boardURL     string
	targets      []string
	wake         chan struct{}
	publish      accountPublishFunc
	retryStart   time.Duration
	retryMax     time.Duration
	runner       sync.WaitGroup
	drainMu      sync.Mutex
}

func NewAccountPublisher(storage *Storage, relayPubkey, relayPrivkey, boardURL string, targets []string) (*AccountPublisher, error) {
	normalizedURL, err := normalizePublicBoardURL(boardURL)
	if err != nil {
		return nil, err
	}
	publisher := &AccountPublisher{
		storage:      storage,
		relayPubkey:  relayPubkey,
		relayPrivkey: relayPrivkey,
		boardURL:     normalizedURL,
		targets:      dedupe(append([]string(nil), targets...)),
		wake:         make(chan struct{}, 1),
		retryStart:   30 * time.Second,
		retryMax:     2 * time.Hour,
	}
	publisher.publish = func(ctx context.Context, relay string, event *nostr.Event) error {
		return publishSignedEvent(ctx, relay, event, relayPrivkey)
	}
	return publisher, nil
}

func normalizePublicBoardURL(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	parsed, err := url.ParseRequestURI(value)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", fmt.Errorf("PUBLIC_BOARD_URL must be an absolute http or https URL")
	}
	return strings.TrimRight(value, "/"), nil
}

func (publisher *AccountPublisher) Targets() []string {
	return append([]string(nil), publisher.targets...)
}

func (publisher *AccountPublisher) BuildQuote(note *nostr.Event, relayHint string) (*nostr.Event, error) {
	if note == nil || note.ID == "" || note.PubKey == "" {
		return nil, fmt.Errorf("cannot quote a note without an id and author")
	}
	var relays []string
	if relayHint != "" {
		relays = []string{relayHint}
	}
	reference, err := nip19.EncodeEvent(note.ID, relays, note.PubKey)
	if err != nil {
		return nil, fmt.Errorf("encode promoted note reference: %w", err)
	}
	parts := []string{promotionQuoteCopy}
	if publisher.boardURL != "" {
		parts = append(parts, publisher.boardURL)
	}
	parts = append(parts, "nostr:"+reference)
	event := &nostr.Event{
		PubKey:    publisher.relayPubkey,
		CreatedAt: nostr.Now(),
		Kind:      1,
		Tags: nostr.Tags{
			{"q", note.ID, relayHint, note.PubKey},
			{"p", note.PubKey},
		},
		Content: strings.Join(parts, "\n\n"),
	}
	if err := event.Sign(publisher.relayPrivkey); err != nil {
		return nil, fmt.Errorf("sign promotion quote: %w", err)
	}
	return event, nil
}

func (publisher *AccountPublisher) buildDeletion(quoteID string) (*nostr.Event, error) {
	event := &nostr.Event{
		PubKey:    publisher.relayPubkey,
		CreatedAt: nostr.Now(),
		Kind:      5,
		Tags: nostr.Tags{
			{"e", quoteID},
			{"k", "1"},
		},
		Content: "",
	}
	if err := event.Sign(publisher.relayPrivkey); err != nil {
		return nil, fmt.Errorf("sign quote deletion: %w", err)
	}
	return event, nil
}

func (publisher *AccountPublisher) RemovePost(postID string) (int64, error) {
	// Let an in-flight quote finish before its deletion is queued. Otherwise a
	// relay could receive the deletion first and the quote immediately after it.
	publisher.drainMu.Lock()
	defer publisher.drainMu.Unlock()

	quote, ok := publisher.storage.QuotePublication(postID)
	if !ok || quote == nil || quote.Event == nil {
		return publisher.storage.RemovePost(postID)
	}
	deletion, err := publisher.buildDeletion(quote.Event.ID)
	if err != nil {
		return 0, err
	}
	targets := quote.Targets
	if len(targets) == 0 {
		targets = publisher.Targets()
	}
	sats, err := publisher.storage.RemovePostWithDeletion(postID, deletion, targets)
	if err == nil {
		publisher.Wake()
	}
	return sats, err
}

func (publisher *AccountPublisher) RestorePost(postID string) error {
	return publisher.storage.RestorePost(postID)
}

func (publisher *AccountPublisher) Wake() {
	select {
	case publisher.wake <- struct{}{}:
	default:
	}
}

func (publisher *AccountPublisher) Start(ctx context.Context) {
	publisher.runner.Add(1)
	go func() {
		defer publisher.runner.Done()
		publisher.run(ctx)
	}()
}

func (publisher *AccountPublisher) Wait() {
	publisher.runner.Wait()
}

func (publisher *AccountPublisher) run(ctx context.Context) {
	delay := publisher.retryStart
	for {
		remaining := publisher.publishPending(ctx)
		if ctx.Err() != nil {
			return
		}
		if remaining == 0 {
			delay = publisher.retryStart
			select {
			case <-ctx.Done():
				return
			case <-publisher.wake:
				continue
			}
		}

		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-publisher.wake:
			if !timer.Stop() {
				<-timer.C
			}
			delay = publisher.retryStart
		case <-timer.C:
			if delay < publisher.retryMax {
				delay *= 3
				if delay > publisher.retryMax {
					delay = publisher.retryMax
				}
			}
		}
	}
}

func (publisher *AccountPublisher) publishPending(ctx context.Context) int {
	publisher.drainMu.Lock()
	defer publisher.drainMu.Unlock()

	jobs := publisher.storage.PendingAccountPublications()
	for _, job := range jobs {
		type result struct {
			relay string
			err   error
		}
		results := make(chan result, len(job.Pending))
		var workers sync.WaitGroup
		for _, relay := range job.Pending {
			workers.Add(1)
			go func(relay string) {
				defer workers.Done()
				results <- result{relay: relay, err: publisher.publish(ctx, relay, job.Record.Event)}
			}(relay)
		}
		workers.Wait()
		close(results)

		accepted := make([]string, 0, len(job.Pending))
		for result := range results {
			if result.err != nil {
				log.Printf("Account %s %s was not accepted by %s: %v",
					job.Record.Type, short(job.Record.Event.ID, 8), result.relay, result.err)
				continue
			}
			accepted = append(accepted, result.relay)
		}
		if len(accepted) == 0 {
			continue
		}
		if err := publisher.storage.MarkAccountPublicationDelivered(job.Key, job.Record.Event.ID, accepted); err != nil {
			log.Printf("Could not save account %s delivery for %s: %v",
				job.Record.Type, short(job.Record.Event.ID, 8), err)
			continue
		}
		log.Printf("Account %s %s reached %d/%d pending relays",
			job.Record.Type, short(job.Record.Event.ID, 8), len(accepted), len(job.Pending))
	}

	remaining := publisher.storage.PendingAccountPublications()
	count := 0
	for _, job := range remaining {
		count += len(job.Pending)
	}
	return count
}

func publishSignedEvent(ctx context.Context, relayURL string, event *nostr.Event, privkey string) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	relay, err := nostr.RelayConnect(ctx, relayURL)
	if err != nil {
		return err
	}
	defer relay.Close()

	if err := relay.Publish(ctx, *event); err == nil {
		return nil
	} else if !strings.Contains(err.Error(), "auth-required") {
		return err
	}

	if err := relay.Auth(ctx, func(authEvent *nostr.Event) error {
		return authEvent.Sign(privkey)
	}); err != nil {
		return fmt.Errorf("relay wanted auth and refused it: %w", err)
	}
	return relay.Publish(ctx, *event)
}
