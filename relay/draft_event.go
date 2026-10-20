package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"fiatjaf.com/nostr"
)

const draftRequestLimit = 128 * 1024
const anonymousNamespace = "space.holoboard.attribution"

// A submitted signed event is a private invoice snapshot, never a cache entry
// or a public outbox item. The author, including its attribution, is immutable.
func validateDraftEvent(event *nostr.Event, reference string) error {
	if event == nil || event.Kind != 1 || event.ID == nostr.ZeroID || event.PubKey == nostr.ZeroPK {
		return fmt.Errorf("event must be a signed kind 1 post")
	}
	if len(event.Content) > 16384 || strings.TrimSpace(event.Content) == "" || len(event.Tags) > 256 {
		return fmt.Errorf("post must contain text within 16 KiB and at most 256 tags")
	}
	for _, tag := range event.Tags {
		if len(tag) == 0 || len(tag) > 8 {
			return fmt.Errorf("invalid post tags")
		}
		for _, value := range tag {
			if len(value) > 4096 {
				return fmt.Errorf("post tag is too long")
			}
		}
		if tag[0] == "e" || tag[0] == "E" {
			return fmt.Errorf("new board posts use quotes, not reply tags")
		}
	}
	if event.GetID() != event.ID {
		return fmt.Errorf("post ID does not match its content")
	}
	if valid, err := verifyNostrEvent(event); err != nil || !valid {
		return fmt.Errorf("invalid post signature")
	}
	if strings.TrimSpace(reference) != "" && normalizeEventID(reference) != event.ID.Hex() {
		return fmt.Errorf("note reference does not match supplied event")
	}
	return nil
}

// This is a signed, self-reported Holoboard label using NIP-32. It does not
// establish key freshness or anonymity from the operator or payment provider.
func anonymousPost(event *nostr.Event) bool {
	if event == nil {
		return false
	}
	namespace, label := false, false
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == "L" && tag[1] == anonymousNamespace {
			namespace = true
		}
		if len(tag) >= 3 && tag[0] == "l" && tag[1] == "anonymous" && tag[2] == anonymousNamespace {
			label = true
		}
	}
	return namespace && label
}

// Recipient hints are not evidence of authorship. Verify quoted sources before
// an invoice is offered and persist the resulting routing identities.
func draftQuoteAuthors(ctx context.Context, storage *Storage, fetcher *PostFetcher, event *nostr.Event) ([]string, error) {
	authors := []string{}
	seen := map[string]bool{}
	for _, tag := range event.Tags {
		if len(tag) == 0 || tag[0] != "q" {
			continue
		}
		if len(tag) != 4 || !isHex64(tag[1]) || !isHex64(tag[3]) {
			return nil, fmt.Errorf("quotes require an event ID and verified author")
		}
		if seen[tag[1]] {
			continue
		}
		seen[tag[1]] = true
		if len(seen) > 32 {
			return nil, fmt.Errorf("use at most 32 quoted posts")
		}
		var source *nostr.Event
		if post, ok := storage.GetPost(tag[1]); ok {
			source = post.Event
		}
		if source == nil {
			if found, ok := storage.GetDiscovery(tag[1]); ok {
				source = found.Event
			}
		}
		if source == nil {
			if fetcher == nil {
				return nil, fmt.Errorf("quoted post is unavailable")
			}
			var err error
			source, err = fetcher.FetchPostFrom(ctx, tag[1], []string{tag[2]}, "")
			if err != nil {
				return nil, fmt.Errorf("could not verify a quoted post")
			}
		}
		valid, _ := verifyNostrEvent(source)
		if !valid || source.ID.Hex() != tag[1] || source.PubKey.Hex() != tag[3] {
			return nil, fmt.Errorf("quoted post does not match its author")
		}
		authors = append(authors, source.PubKey.Hex())
	}
	return dedupe(authors), nil
}

// Rollback hides new admission but keeps already issued invoices recoverable.
func draftAdmissionEnabled(storage *Storage, event *nostr.Event) bool {
	if os.Getenv("ENABLE_POST_CREATION") == "true" {
		return true
	}
	if storage.HasPost(event.ID.Hex()) {
		return true
	}
	for _, invoice := range storage.ListPendingInvoices() {
		if invoice.PublishOriginal && invoice.PostID == event.ID.Hex() {
			return true
		}
	}
	return false
}
