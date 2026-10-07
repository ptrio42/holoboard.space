package main

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

type metadataEntry struct {
	event    *nostr.Event
	expires  time.Time
	resolved bool
}

var metadataCache = struct {
	sync.Mutex
	entries map[string]metadataEntry
	pending map[string]chan struct{}
}{entries: map[string]metadataEntry{}, pending: map[string]chan struct{}{}}

// Both NIP-65 and NIP-17 discovery share bounded, deduplicated metadata reads.
// A timeout can return observed signed data, but never caches a false absence.
func queryRelayMetadata(ctx context.Context, kind int, author string, searchOn []string) *nostr.Event {
	event, _ := queryRelayMetadataStatus(ctx, kind, author, searchOn)
	return event
}

func queryRelayMetadataStatus(ctx context.Context, kind int, author string, searchOn []string) (*nostr.Event, bool) {
	sources := safeRelayCandidates(append(append([]string{}, searchOn...), discoveryRelays...))
	key := fmt.Sprintf("%d:%s:%s", kind, author, strings.Join(sources, ","))
	metadataCache.Lock()
	if entry, ok := metadataCache.entries[key]; ok && time.Now().Before(entry.expires) {
		metadataCache.Unlock()
		return cloneNostrEvent(entry.event), entry.resolved
	}
	if pending := metadataCache.pending[key]; pending != nil {
		metadataCache.Unlock()
		select {
		case <-pending:
			return queryRelayMetadataStatus(ctx, kind, author, searchOn)
		case <-ctx.Done():
			return nil, false
		}
	}
	if len(metadataCache.pending) >= 8 || ctx.Err() != nil {
		metadataCache.Unlock()
		return nil, false
	}
	pending := make(chan struct{})
	metadataCache.pending[key] = pending
	metadataCache.Unlock()
	defer func() {
		metadataCache.Lock()
		delete(metadataCache.pending, key)
		close(pending)
		metadataCache.Unlock()
	}()
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	type result struct {
		events []*nostr.Event
		err    error
	}
	results := make(chan result, len(sources))
	for _, url := range sources {
		go func(url string) {
			relay, err := connectRelay(ctx, url)
			if err != nil {
				results <- result{err: err}
				return
			}
			defer relay.Close()
			events, err := relay.QuerySync(ctx, nostr.Filter{Kinds: []int{kind}, Authors: []string{author}, Limit: 1})
			results <- result{events, err}
		}(url)
	}
	var newest *nostr.Event
	complete := len(sources) > 0
	for range sources {
		answer := <-results
		if answer.err != nil {
			complete = false
		}
		for _, event := range answer.events {
			if event.Kind != kind || event.PubKey != author {
				continue
			}
			valid, err := event.CheckSignature()
			if err == nil && valid && newerReplaceableEvent(event, newest) {
				newest = event
			}
		}
	}
	ttl := 5 * time.Minute
	if newest == nil || !complete {
		ttl = 30 * time.Second
	}
	if newest == nil && !complete {
		ttl = 5 * time.Second
	}
	var encoded []byte
	if newest != nil {
		encoded, _ = newest.MarshalJSON()
	}
	if len(encoded) <= 8192 {
		metadataCache.Lock()
		for id, entry := range metadataCache.entries {
			if !time.Now().Before(entry.expires) {
				delete(metadataCache.entries, id)
			}
		}
		if len(metadataCache.entries) >= 256 {
			for id := range metadataCache.entries {
				delete(metadataCache.entries, id)
				break
			}
		}
		metadataCache.entries[key] = metadataEntry{cloneNostrEvent(newest), time.Now().Add(ttl), complete || newest != nil}
		metadataCache.Unlock()
	}
	return newest, complete || newest != nil
}

func authorReadRelays(ctx context.Context, author string, searchOn []string) []string {
	list := queryRelayMetadata(ctx, kindRelayList, author, searchOn)
	if list == nil {
		return nil
	}
	var reads []string
	for _, tag := range list.Tags {
		if len(tag) >= 2 && tag[0] == "r" && (len(tag) < 3 || tag[2] == "" || tag[2] == "read") {
			reads = append(reads, tag[1])
		}
	}
	return safeRelayCandidates(reads)[:min(len(safeRelayCandidates(reads)), 4)]
}
