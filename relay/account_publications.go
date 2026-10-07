package main

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"

	"fiatjaf.com/nostr"
)

const promotionQuoteCopy = "Paid promotion on Holoboard. Zap this Holoboard post to boost the quoted note."

func quotePublicationKey(noteID string) string {
	return "quote:" + noteID
}

func deletionPublicationKey(eventID string) string {
	return "deletion:" + eventID
}

func replyPublicationKey(mentionID string) string {
	return "reply:" + mentionID
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

// QueueAccountReply durably queues instruction/error replies with the same
// signed-event retry semantics as promotion replies, without a zap mapping.
func (s *Storage) QueueAccountReply(mentionID string, reply *nostr.Event, targets []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := replyPublicationKey(mentionID)
	if _, exists := s.accountPublications[key]; exists {
		return nil
	}
	wasProcessed := s.processedMentions[mentionID]
	s.accountPublications[key] = newAccountPublication(accountPublicationReply, "", reply, targets)
	s.processedMentions[mentionID] = true
	if err := s.save(); err != nil {
		delete(s.accountPublications, key)
		if wasProcessed {
			s.processedMentions[mentionID] = true
		} else {
			delete(s.processedMentions, mentionID)
		}
		return err
	}
	return nil
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

// QueuePromotionalReply commits the signed reply, its zap mapping and the
// processed mention together. A retry must publish this same event ID.
func (s *Storage) QueuePromotionalReply(mentionID, noteID, requester string, reply *nostr.Event, targets []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := replyPublicationKey(mentionID)
	if _, exists := s.accountPublications[key]; exists {
		return nil
	}
	s.accountPublications[key] = newAccountPublication(accountPublicationReply, noteID, reply, targets)
	s.promotionalReplies[reply.ID.Hex()] = noteID
	s.promotionRequesters[reply.ID.Hex()] = requester
	s.processedMentions[mentionID] = true
	if err := s.save(); err != nil {
		delete(s.accountPublications, key)
		delete(s.promotionalReplies, reply.ID.Hex())
		delete(s.promotionRequesters, reply.ID.Hex())
		delete(s.processedMentions, mentionID)
		return fmt.Errorf("save promotional reply: %w", err)
	}
	return nil
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
	if !ok || record == nil || record.Event == nil || record.Event.ID.Hex() != eventID || record.Cancelled {
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
	profile      func(context.Context, string, []string) (*nostr.Event, string)
	readRelays   func(context.Context, string, []string) []string
	retryStart   time.Duration
	retryMax     time.Duration
	runner       sync.WaitGroup
	drainMu      sync.Mutex
}

func NewAccountPublisher(storage *Storage, relayPubkey, relayPrivkey, boardURL string, targets []string) (*AccountPublisher, error) {
	trustConfiguredRelays(targets)
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
	publisher.profile = findRecipientProfile
	publisher.readRelays = authorReadRelays
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
	return publisher.BuildQuoteWithSplit(note, relayHint, defaultAuthorShare)
}

func (publisher *AccountPublisher) BuildQuoteWithSplit(note *nostr.Event, relayHint string, authorShare int) (*nostr.Event, error) {
	if authorShare < 0 || authorShare > 99 {
		return nil, fmt.Errorf("author share must be between 0 and 99 percent")
	}
	if note == nil || note.ID == nostr.ZeroID || note.PubKey == nostr.ZeroPK {
		return nil, fmt.Errorf("cannot quote a note without an id and author")
	}
	var relays []string
	if relayHint != "" {
		relays = []string{relayHint}
	}
	reference, err := encodeEventReference(note.ID.Hex(), relays, note.PubKey.Hex())
	if err != nil {
		return nil, fmt.Errorf("encode promoted note reference: %w", err)
	}
	parts := []string{promotionQuoteCopy}
	if publisher.boardURL != "" {
		parts = append(parts, publisher.boardURL)
	}
	parts = append(parts, "nostr:"+reference)
	event := &nostr.Event{
		PubKey:    nostr.MustPubKeyFromHex(publisher.relayPubkey),
		CreatedAt: nostr.Now(),
		Kind:      1,
		Tags: nostr.Tags{
			{"q", note.ID.Hex(), relayHint, note.PubKey.Hex()},
			{"p", note.PubKey.Hex()},
		},
		Content: strings.Join(parts, "\n\n"),
	}
	// NIP-57 Appendix G requires the recipient's kind:0 source, not a relay
	// merely used to publish this quote. Resolve recipients independently.
	ctx, cancel := context.WithTimeout(context.Background(), profileFetchTimeout)
	defer cancel()
	sources := dedupe(append(relays, publisher.targets...))
	var boardProfileRelay, authorProfileRelay string
	var authorProfile *nostr.Event
	var lookups sync.WaitGroup
	lookups.Add(1)
	go func() {
		defer lookups.Done()
		profile, source := publisher.profile(ctx, publisher.relayPubkey, sources)
		if validRecipientProfile(profile, publisher.relayPubkey) && profileHasPaymentAddress(profile) {
			boardProfileRelay = source
		}
	}()
	if authorShare > 0 {
		lookups.Add(1)
		go func() {
			defer lookups.Done()
			authorProfile, authorProfileRelay = publisher.profile(ctx, note.PubKey.Hex(), sources)
		}()
	}
	lookups.Wait()
	if validRecipientProfile(authorProfile, note.PubKey.Hex()) && profileHasNoPaymentAddress(authorProfile) {
		authorShare = 0
	}
	if !validRecipientProfile(authorProfile, note.PubKey.Hex()) || !profileHasPaymentAddress(authorProfile) {
		authorProfileRelay = ""
	}
	// An unavailable profile must not reject a paid promotion, fabricate a
	// source, or change the split. Only confirmed absence of an address uses 100%
	// visibility for a new quote. Existing campaign quotes are never replaced.
	event.Tags = append(event.Tags, nostr.Tag{"zap", publisher.relayPubkey, boardProfileRelay, fmt.Sprint(100 - authorShare)})
	if authorShare > 0 {
		event.Tags = append(event.Tags, nostr.Tag{"zap", note.PubKey.Hex(), authorProfileRelay, fmt.Sprint(authorShare)})
	}
	if err := signEvent(event, publisher.relayPrivkey); err != nil {
		return nil, fmt.Errorf("sign promotion quote: %w", err)
	}
	return event, nil
}

func (publisher *AccountPublisher) buildDeletion(quoteID string) (*nostr.Event, error) {
	event := &nostr.Event{
		PubKey:    nostr.MustPubKeyFromHex(publisher.relayPubkey),
		CreatedAt: nostr.Now(),
		Kind:      5,
		Tags: nostr.Tags{
			{"e", quoteID},
			{"k", "1"},
		},
		Content: "",
	}
	if err := signEvent(event, publisher.relayPrivkey); err != nil {
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
	deletion, err := publisher.buildDeletion(quote.Event.ID.Hex())
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

// ExtendAccountPublicationTargets saves destinations before any EVENT is sent.
// The record shape stays compatible with existing deployments and rollback.
func (s *Storage) ExtendAccountPublicationTargets(key, eventID string, targets []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	record := s.accountPublications[key]
	if record == nil || record.Event == nil || record.Event.ID.Hex() != eventID || record.Cancelled {
		return fmt.Errorf("publication is no longer pending")
	}
	updated := cloneAccountPublication(record)
	updated.Targets = dedupe(append(updated.Targets, targets...))
	if len(updated.Targets) == len(record.Targets) {
		return nil
	}
	s.accountPublications[key] = updated
	if err := s.save(); err != nil {
		s.accountPublications[key] = record
		return err
	}
	return nil
}

func (publisher *AccountPublisher) publishPending(ctx context.Context) int {
	publisher.drainMu.Lock()
	defer publisher.drainMu.Unlock()

	jobs := publisher.storage.PendingAccountPublications()
	for _, job := range jobs {
		if publisher.boardURL != "" && publisher.readRelays != nil && job.Record.Event.Kind != 5 {
			routeCtx, stop := context.WithTimeout(ctx, 4*time.Second)
			var destinations []string
			recipients := map[string]bool{}
			for _, tag := range job.Record.Event.Tags {
				if len(tag) < 2 || tag[0] != "p" || !isHex64(tag[1]) || recipients[tag[1]] {
					continue
				}
				if len(recipients) >= 4 {
					break
				}
				recipients[tag[1]] = true
				destinations = append(destinations, publisher.readRelays(routeCtx, tag[1], publisher.targets)...)
			}
			stop()
			destinations = safeRelayCandidates(destinations)
			if err := publisher.storage.ExtendAccountPublicationTargets(job.Key, job.Record.Event.ID.Hex(), destinations); err != nil {
				log.Printf("Could not persist publication routing: %v", err)
				continue
			}
			job.Record.Targets = dedupe(append(job.Record.Targets, destinations...))
			job.Pending = pendingRelayTargets(job.Record)
		}
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
					job.Record.Type, short(job.Record.Event.ID.Hex(), 8), result.relay, result.err)
				continue
			}
			accepted = append(accepted, result.relay)
		}
		if len(accepted) == 0 {
			continue
		}
		if err := publisher.storage.MarkAccountPublicationDelivered(job.Key, job.Record.Event.ID.Hex(), accepted); err != nil {
			log.Printf("Could not save account %s delivery for %s: %v",
				job.Record.Type, short(job.Record.Event.ID.Hex(), 8), err)
			continue
		}
		log.Printf("Account %s %s reached %d/%d pending relays",
			job.Record.Type, short(job.Record.Event.ID.Hex(), 8), len(accepted), len(job.Pending))
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

	relay, err := connectRelay(ctx, relayURL)
	if err != nil {
		return err
	}
	defer relay.Close()

	if err := relay.Publish(ctx, *event); err == nil {
		return nil
	} else if !strings.Contains(err.Error(), "auth-required") {
		return err
	}

	if err := relay.Auth(ctx, func(_ context.Context, authEvent *nostr.Event) error {
		return signEvent(authEvent, privkey)
	}); err != nil {
		return fmt.Errorf("relay wanted auth and refused it: %w", err)
	}
	return relay.Publish(ctx, *event)
}
