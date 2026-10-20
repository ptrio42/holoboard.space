package main

import (
	"sort"
	"time"

	"fiatjaf.com/nostr"
)

// PublicDiscovery is intentionally separate from the private reward journal.
type PublicDiscovery struct {
	Reason       string `json:"reason"`
	Topic        string `json:"topic"`
	Language     string `json:"language"`
	ExpiresAt    int64  `json:"expires_at"`
	RewardSats   int64  `json:"reward_sats"`
	RewardStatus string `json:"reward_status"`
}

type CuratorFeedEntry struct {
	*CampaignEntry
	EntryType            string           `json:"entry_type"`
	ID                   string           `json:"id"`
	Event                *nostr.Event     `json:"event"`
	FirstVisibleAt       int64            `json:"first_visible_at"`
	Discovery            *PublicDiscovery `json:"discovery,omitempty"`
	firstVisibleAtMillis int64
}

func publicDiscovery(d *Discovery) *PublicDiscovery {
	if d == nil {
		return nil
	}
	status := d.Reward.Status
	if status == "rejected" {
		// Keep older discovery clients compatible with private review outcomes.
		status = "failed"
	}
	return &PublicDiscovery{d.Reason, d.Topic, d.Language, d.ExpiresAt.Unix(), d.Reward.AmountSats, status}
}

// DiscoveryWaitingEntries preserves the paid ranking and overlays only the New
// view. Historical discovery exposure survives a later payment and expiry.
func (s *Storage) DiscoveryWaitingEntries(paid []CampaignEntry, now time.Time) []CuratorFeedEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	entries := []CuratorFeedEntry{}
	paidIDs := map[string]bool{}
	for _, entry := range paid {
		paidIDs[entry.ID] = true
		if entry.Rank <= mainBoardSize || s.removed[entry.ID] {
			continue
		}
		var discovery *Discovery
		if s.curator != nil {
			discovery = s.curator.Discoveries[entry.ID]
		}
		visibleMillis := entry.firstPaidAtMillis
		if discovery != nil && discovery.CreatedAt.UnixMilli() < visibleMillis {
			visibleMillis = discovery.CreatedAt.UnixMilli()
		}
		copy := entry
		entries = append(entries, CuratorFeedEntry{&copy, "promotion", entry.ID, cloneNostrEvent(entry.Event), visibleMillis / 1000, publicDiscovery(discovery), visibleMillis})
	}
	if s.curator != nil {
		for id, d := range s.curator.Discoveries {
			if paidIDs[id] || s.removed[id] || !d.ExpiresAt.After(now) || d.CreatedAt.After(now) {
				continue
			}
			entries = append(entries, CuratorFeedEntry{nil, "discovery", id, cloneNostrEvent(d.Event), d.CreatedAt.Unix(), publicDiscovery(d), d.CreatedAt.UnixMilli()})
		}
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].firstVisibleAtMillis == entries[j].firstVisibleAtMillis {
			return entries[i].ID < entries[j].ID
		}
		return entries[i].firstVisibleAtMillis > entries[j].firstVisibleAtMillis
	})
	return entries
}
