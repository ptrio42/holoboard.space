package main

import (
	"fmt"
	"slices"
	"testing"
	"time"
)

func TestCuratorBatchSpreadsAcrossAuthorsAndPreservesIssuedSnapshot(t *testing.T) {
	c, now := curatorFixture(t, false)
	floodAuthor := generatePrivateKey()
	for i := range 120 {
		note := curatorNote(t, fmt.Sprintf("Repeated author %d", i), *now, floodAuthor)
		c.storage.curator.Candidates[note.ID.Hex()] = &CuratorCandidate{Event: note, FirstSeenAt: *now}
	}
	for i := range 60 {
		note := curatorNote(t, fmt.Sprintf("Independent author %d", i), now.Add(-24*time.Hour), "")
		c.storage.curator.Candidates[note.ID.Hex()] = &CuratorCandidate{Event: note, FirstSeenAt: now.Add(-time.Hour)}
	}
	batchID := seedCurator(t, c)
	var original *curatorBatch
	for _, batch := range c.storage.curator.Batches {
		original = batch
	}
	authors := map[string]bool{}
	for _, candidate := range original.Candidates {
		authors[candidate.Event.PubKey.Hex()] = true
	}
	if len(original.Candidates) != 50 || len(authors) != 50 {
		t.Fatalf("expected fifty distinct authors, got %d notes / %d authors", len(original.Candidates), len(authors))
	}
	note := curatorNote(t, "New candidate after the snapshot was issued", *now, "")
	if retry := seedCurator(t, c, note); retry != batchID {
		t.Fatal("adding a candidate changed the issued batch ID")
	}
	for _, batch := range c.storage.curator.Batches {
		if batch.Candidates[note.ID.Hex()] != nil || len(batch.Candidates) != 50 {
			t.Fatal("adding a candidate changed an issued snapshot")
		}
	}
}

func TestCuratorSampleIsStableAndRotatesWithoutFavoringLowIDs(t *testing.T) {
	_, now := curatorFixture(t, false)
	candidates := []*CuratorCandidate{}
	for i := range 80 {
		note := curatorNote(t, fmt.Sprint(i), *now, "")
		// Exercise the low-ID ordering failure without mining proof of work.
		note.ID = eventIDs(fmt.Sprintf("%064x", i+1))[0]
		candidates = append(candidates, &CuratorCandidate{Event: note})
	}
	ids := func(sample []*CuratorCandidate) []string {
		result := []string{}
		for _, candidate := range sample {
			result = append(result, candidate.Event.ID.Hex())
		}
		return result
	}
	first := ids(sampleCuratorCandidates(candidates, "slot-a", 20))
	slices.Reverse(candidates)
	if !slices.Equal(first, ids(sampleCuratorCandidates(candidates, "slot-a", 20))) {
		t.Fatal("input order changed the sample")
	}
	if slices.Equal(first, ids(sampleCuratorCandidates(candidates, "slot-b", 20))) {
		t.Fatal("another slot did not rotate the sample")
	}
	allLow := true
	for _, id := range first {
		if id > fmt.Sprintf("%064x", 20) {
			allLow = false
		}
	}
	if allLow {
		t.Fatal("low IDs monopolized the sample")
	}
	if got := len(sampleCuratorCandidates(candidates, "slot-a", 100)); got != 80 {
		t.Fatalf("small pools lost candidates: %d", got)
	}
}
