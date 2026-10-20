package main

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
)

// Visit each author once before taking another note from any author. A seeded
// hash rotates the order without giving low event IDs a sampling advantage.
func sampleCuratorCandidates(candidates []*CuratorCandidate, seed string, limit int) []*CuratorCandidate {
	rank := func(value string) string {
		digest := sha256.Sum256([]byte(seed + ":" + value))
		return hex.EncodeToString(digest[:])
	}
	groups := map[string][]*CuratorCandidate{}
	ranks := map[string]string{}
	for _, candidate := range candidates {
		author := candidate.Event.PubKey.Hex()
		groups[author] = append(groups[author], candidate)
		ranks[author] = rank(author)
		ranks[candidate.Event.ID.Hex()] = rank(candidate.Event.ID.Hex())
	}
	less := func(a, b string) bool {
		if ranks[a] == ranks[b] {
			return a < b
		}
		return ranks[a] < ranks[b]
	}
	authors := make([]string, 0, len(groups))
	for author, notes := range groups {
		authors = append(authors, author)
		sort.Slice(notes, func(i, j int) bool { return less(notes[i].Event.ID.Hex(), notes[j].Event.ID.Hex()) })
	}
	sort.Slice(authors, func(i, j int) bool { return less(authors[i], authors[j]) })
	selected := make([]*CuratorCandidate, 0, min(max(limit, 0), len(candidates)))
	for round := 0; len(selected) < limit; round++ {
		added := false
		for _, author := range authors {
			if notes := groups[author]; round < len(notes) {
				selected = append(selected, notes[round])
				added = true
				if len(selected) == limit {
					break
				}
			}
		}
		if !added {
			break
		}
	}
	return selected
}
