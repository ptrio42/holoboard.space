package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"sync"
	"time"

	"fiatjaf.com/nostr"
)

type curatorQueryFunc func(context.Context, string, nostr.Filter) ([]*nostr.Event, error)

type curatorCollectionSource struct {
	Relay     string `json:"relay"`
	Queries   int    `json:"queries"`
	Completed int    `json:"completed"`
	Failed    int    `json:"failed"`
	Limited   int    `json:"limited"`
}

type curatorCollectionStatus struct {
	Scope              string                    `json:"scope"`
	AttemptedAt        time.Time                 `json:"attempted_at"`
	Sources            []curatorCollectionSource `json:"sources"`
	Queries            int                       `json:"queries"`
	Completed          int                       `json:"completed"`
	Failed             int                       `json:"failed"`
	Limited            int                       `json:"limited"`
	TimedOut           bool                      `json:"timed_out"`
	CandidateByteLimit bool                      `json:"candidate_byte_limit"`
}

func queryCuratorRelay(ctx context.Context, source string, filter nostr.Filter) ([]*nostr.Event, error) {
	relay, err := connectRelay(ctx, source)
	if err != nil {
		return nil, err
	}
	defer relay.Close()
	sub, err := relay.SubscribeFilters(ctx, []nostr.Filter{filter})
	if err != nil {
		return nil, err
	}
	defer sub.Unsub()
	events := []*nostr.Event{}
	for {
		select {
		case event, ok := <-sub.Events:
			if !ok {
				return events, nil
			}
			if filter.Matches(event) {
				events = append(events, cloneNostrEvent(&event))
			}
			if len(events) >= filter.Limit {
				return events, nil
			}
		case <-sub.EndOfStoredEvents:
			return events, nil
		case <-sub.ClosedReason:
			return events, fmt.Errorf("collector query interrupted")
		case <-ctx.Done():
			return events, ctx.Err()
		}
	}
}

func (c *CuratorService) Start(ctx context.Context) {
	if c.initErr != nil {
		return
	}
	go func() {
		c.collect(ctx)
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				c.collect(ctx)
			}
		}
	}()
}

type curatorQuery struct {
	source string
	filter nostr.Filter
}

func (c *CuratorService) collect(parent context.Context) {
	if c.initErr != nil {
		return
	}
	now := c.now().UTC()
	c.storage.mu.RLock()
	state := c.storage.curator
	allowed := state != nil && (state.Mode == curatorDryRun || curatorIsActive(state, now))
	c.storage.mu.RUnlock()
	if !allowed {
		return
	}
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	sources := safeRelayCandidates(c.config.Relays)
	if len(sources) == 0 && c.fetcher != nil {
		sources = safeRelayCandidates(c.fetcher.Relays())
	}
	if len(sources) == 0 {
		return
	}
	// Vary both relay order and the age window. Older notes remain eligible;
	// candidate and issued-batch expiry are separate local cache lifetimes.
	hour := int(now.Unix() / 3600)
	rotated := append(append([]string{}, sources[hour%len(sources):]...), sources[:hour%len(sources)]...)
	sources = rotated[:min(4, len(rotated))]
	seenSources := map[string]bool{}
	for _, source := range sources {
		seenSources[source] = true
	}
	searches := []string{"", "art", "science", "music", "nature", "projet", "ciencia", "sztuka", "写真", "cultura", "lernen", "community", "projeto"}
	queries := []curatorQuery{}
	for i, source := range sources {
		age := []time.Duration{24 * time.Hour, 7 * 24 * time.Hour, 30 * 24 * time.Hour, 90 * 24 * time.Hour}[(hour+i)%4]
		until := now
		if age > 24*time.Hour {
			until = now.Add(-age / 3)
		}
		filter := nostr.Filter{Kinds: []nostr.Kind{1, 1111}, Since: nostr.Timestamp(now.Add(-age).Unix()), Until: nostr.Timestamp(until.Unix()), Limit: 166}
		queries = append(queries, curatorQuery{source, filter})
		// Text search is optional on public relays. Keep ordinary reads independent.
		if search := searches[(hour+i)%len(searches)]; search != "" {
			filter.Search = search
			queries = append(queries, curatorQuery{source, filter})
		}
	}
	candidates := map[string]*CuratorCandidate{}
	candidateBytes := 0
	byteLimited := false
	outcomes := map[string]*curatorCollectionSource{}
	var mu sync.Mutex
	runQueries := func(queries []curatorQuery) {
		var workers sync.WaitGroup
		jobs := make(chan curatorQuery)
		for range min(4, len(queries)) {
			workers.Go(func() {
				for job := range jobs {
					queryCtx, queryCancel := context.WithTimeout(ctx, 4*time.Second)
					events, queryErr := c.query(queryCtx, job.source, job.filter)
					queryCancel()
					mu.Lock()
					outcome := outcomes[job.source]
					if outcome == nil {
						outcome = &curatorCollectionSource{Relay: job.source}
						outcomes[job.source] = outcome
					}
					outcome.Queries++
					if queryErr != nil {
						outcome.Failed++
					} else if len(events) >= job.filter.Limit {
						outcome.Limited++
					} else {
						outcome.Completed++
					}
					mu.Unlock()
					for _, event := range events[:min(len(events), 166)] {
						if event == nil || !job.filter.Matches(*event) || !validCuratorEvent(event, now) || (len(job.filter.IDs) == 0 && int64(event.CreatedAt) < now.Add(-90*24*time.Hour).Unix()) {
							continue
						}
						id := event.ID.Hex()
						mu.Lock()
						if previous := candidates[id]; previous != nil {
							beforeBytes, _ := json.Marshal(previous)
							updated := *previous
							updated.SourceRelays = dedupe(append(append([]string(nil), previous.SourceRelays...), job.source))
							afterBytes, _ := json.Marshal(updated)
							if candidateBytes+len(afterBytes)-len(beforeBytes) <= curatorCandidateBytes {
								candidates[id] = &updated
								candidateBytes += len(afterBytes) - len(beforeBytes)
							} else {
								byteLimited = true
							}
						} else if len(candidates) < curatorCandidateLimit {
							candidate := &CuratorCandidate{cloneNostrEvent(event), []string{job.source}, now}
							encoded, _ := json.Marshal(candidate)
							if candidateBytes+len(encoded) <= curatorCandidateBytes {
								candidates[id] = candidate
								candidateBytes += len(encoded)
							} else {
								byteLimited = true
							}
						}
						mu.Unlock()
					}
				}
			})
		}
		for _, job := range queries {
			select {
			case jobs <- job:
			case <-ctx.Done():
				close(jobs)
				workers.Wait()
				return
			}
		}
		close(jobs)
		workers.Wait()
	}
	runQueries(queries)
	// Traverse public references and author outboxes without adding their URLs
	// to publication or payment-monitor relay configuration.
	ids := []string{}
	authors := []string{}
	seeds := make([]*CuratorCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		seeds = append(seeds, candidate)
	}
	for _, candidate := range sampleCuratorCandidates(seeds, fmt.Sprintf("collect-%d", hour), len(seeds)) {
		authors = append(authors, candidate.Event.PubKey.Hex())
		for _, tag := range candidate.Event.Tags {
			if len(tag) >= 2 && (tag[0] == "e" || tag[0] == "q") && isHex64(tag[1]) {
				ids = append(ids, tag[1])
				if len(tag) >= 3 {
					for _, source := range safeRelayCandidates([]string{tag[2]}) {
						if len(seenSources) < 12 {
							seenSources[source] = true
						}
					}
				}
			}
		}
	}
	ids = dedupe(ids)
	ids = ids[:min(32, len(ids))]
	authors = dedupe(authors)
	authors = authors[:min(4, len(authors))]
	for _, author := range authors {
		if ctx.Err() != nil {
			break
		}
		lookupCtx, lookupCancel := context.WithTimeout(ctx, time.Second)
		writes := c.writeRelays(lookupCtx, author, sources[:1])
		lookupCancel()
		for _, source := range safeRelayCandidates(writes) {
			if len(seenSources) < 12 {
				seenSources[source] = true
			}
		}
	}
	queries = nil
	for source := range seenSources {
		filter := nostr.Filter{Kinds: []nostr.Kind{1, 1111}, Authors: publicKeys(authors...), Since: nostr.Timestamp(now.Add(-90 * 24 * time.Hour).Unix()), Limit: 166}
		if len(authors) > 0 {
			queries = append(queries, curatorQuery{source, filter})
		}
		if len(ids) > 0 {
			filter.IDs = eventIDs(ids...)
			filter.Authors = nil
			filter.Since = 0
			queries = append(queries, curatorQuery{source, filter})
		}
	}
	if ctx.Err() == nil {
		runQueries(queries)
	}
	c.storage.mu.Lock()
	defer c.storage.mu.Unlock()
	before := c.storage.curator
	if before.Mode != curatorDryRun && !curatorIsActive(before, now) {
		return
	}
	next := cloneCuratorState(before)
	for id, candidate := range candidates {
		if c.eligibleLocked(next, candidate, now) != "" {
			continue
		}
		if _, rejected := next.Rejected[id]; rejected {
			continue
		}
		if existing := next.Candidates[id]; existing != nil {
			candidate.FirstSeenAt = existing.FirstSeenAt
			candidate.SourceRelays = dedupe(append(existing.SourceRelays, candidate.SourceRelays...))
			candidate.SourceRelays = candidate.SourceRelays[:min(len(candidate.SourceRelays), 12)]
		}
		next.Candidates[id] = candidate
	}
	next.LastCollection = curatorCollectionStatus{Scope: "partial_public_sample", AttemptedAt: now, Sources: []curatorCollectionSource{}, TimedOut: ctx.Err() != nil, CandidateByteLimit: byteLimited}
	for _, outcome := range outcomes {
		next.LastCollection.Sources = append(next.LastCollection.Sources, *outcome)
		next.LastCollection.Queries += outcome.Queries
		next.LastCollection.Completed += outcome.Completed
		next.LastCollection.Failed += outcome.Failed
		next.LastCollection.Limited += outcome.Limited
	}
	sort.Slice(next.LastCollection.Sources, func(i, j int) bool {
		return next.LastCollection.Sources[i].Relay < next.LastCollection.Sources[j].Relay
	})
	if next.LastCollection.Completed+next.LastCollection.Limited > 0 {
		next.LastCollectedAt = now
	}
	c.pruneLocked(next, now)
	c.storage.curator = next
	if err := c.storage.save(); err != nil {
		c.storage.curator = before
		log.Print("Could not persist curator collection")
	}
}
