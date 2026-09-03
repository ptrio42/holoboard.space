package main

import (
	"context"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// The point of decay: sats do not stop having been paid, they stop being
// recent, so a note nobody has paid for in months gives way to one somebody
// paid for this week.
func TestOlderPaymentsCountForLess(t *testing.T) {
	now := time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC)

	fresh := &PromotedPost{
		TotalSatsPaid: 100,
		Payments:      []Payment{{Sats: 100, At: now}},
	}
	old := &PromotedPost{
		TotalSatsPaid: 100,
		Payments:      []Payment{{Sats: 100, At: now.Add(-rankHalfLife)}},
	}

	if got := old.score(now); got < 49 || got > 51 {
		t.Errorf("a payment one half-life old scored %.1f, want about half of 100", got)
	}
	if fresh.score(now) <= old.score(now) {
		t.Error("a payment made today should count for more than one made a half-life ago")
	}
	if !rankLessAt(fresh, old, now) {
		t.Error("the fresher note should rank first")
	}
}

// The exploit this design exists to prevent: if the whole total decayed from
// the date of the most recent payment, a single sat would restore all of it.
func TestOneSatCannotRefreshAnOldFortune(t *testing.T) {
	now := time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC)
	longAgo := now.Add(-4 * rankHalfLife)

	// Paid a fortune once, four half-lives ago, then a single sat just now.
	gaming := &PromotedPost{
		TotalSatsPaid:        10001,
		LastPaymentTimestamp: now,
		Payments: []Payment{
			{Sats: 10000, At: longAgo},
			{Sats: 1, At: now},
		},
	}
	// Paid a thousand today, honestly.
	honest := &PromotedPost{
		TotalSatsPaid:        1000,
		LastPaymentTimestamp: now,
		Payments:             []Payment{{Sats: 1000, At: now}},
	}

	if gaming.score(now) >= honest.score(now) {
		t.Errorf("a four half-life old fortune (%.1f) still outranks a fresh 1000 (%.1f); "+
			"one sat bought back the whole total",
			gaming.score(now), honest.score(now))
	}
	if !rankLessAt(honest, gaming, now) {
		t.Error("the honest note should rank first")
	}
	// The reported figure is untouched: what was paid is a fact.
	if gaming.TotalSatsPaid != 10001 {
		t.Error("the sats paid should be reported as they were paid")
	}
}

// Everything stored before payment history existed still has to rank, dated
// from what was recorded at the time.
func TestPostsWithoutHistoryStillDecay(t *testing.T) {
	now := time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC)

	legacy := &PromotedPost{
		TotalSatsPaid:        200,
		LastPaymentTimestamp: now.Add(-rankHalfLife),
	}

	if got := legacy.score(now); got < 99 || got > 101 {
		t.Errorf("a legacy post scored %.1f, want about half of 200", got)
	}

	// And one paid today outranks it, which is the whole point.
	fresh := &PromotedPost{TotalSatsPaid: 150, Payments: []Payment{{Sats: 150, At: now}}}
	if !rankLessAt(fresh, legacy, now) {
		t.Error("150 sats today should outrank 200 sats a half-life ago")
	}
}

// Several payments add up, each faded from its own date rather than from the
// newest one.
func TestPaymentsAddUpIndividually(t *testing.T) {
	now := time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC)

	post := &PromotedPost{
		TotalSatsPaid: 300,
		Payments: []Payment{
			{Sats: 100, At: now},
			{Sats: 100, At: now.Add(-rankHalfLife)},
			{Sats: 100, At: now.Add(-2 * rankHalfLife)},
		},
	}

	// 100 + 50 + 25
	if got := post.score(now); got < 174 || got > 176 {
		t.Errorf("score = %.1f, want about 175", got)
	}
}

func TestCommentsAreRankable(t *testing.T) {
	for _, kind := range []int{1, kindComment} {
		if !isPromotable(kind) {
			t.Errorf("kind %d should be promotable", kind)
		}
	}
	for _, kind := range []int{0, 6, 7, 30023, 9735, 1059} {
		if isPromotable(kind) {
			t.Errorf("kind %d should not be promotable", kind)
		}
	}
}

// seedPaidPost puts a note on the board with one payment, dated.
func seedPaidPost(t *testing.T, s *Storage, sats int64, paidAt time.Time) string {
	t.Helper()

	evt := &nostr.Event{CreatedAt: nostr.Now(), Kind: 1, Tags: nostr.Tags{}, Content: "note"}
	if err := evt.Sign(nostr.GeneratePrivateKey()); err != nil {
		t.Fatalf("failed to sign: %v", err)
	}
	if err := s.AddPayment(evt.ID, sats, evt); err != nil {
		t.Fatalf("failed to add payment: %v", err)
	}

	// AddPayment stamps the present, so backdate what it wrote.
	s.mu.Lock()
	post := s.posts[evt.ID]
	post.LastPaymentTimestamp = paidAt
	for i := range post.Payments {
		post.Payments[i].At = paidAt
	}
	s.mu.Unlock()

	return evt.ID
}

// AddPayment has to record the history the ranking is built from. Every other
// test in this file constructs that history by hand, which proves the maths and
// nothing about whether anything ever writes it.
func TestPaymentsAreRecordedAsTheyArrive(t *testing.T) {
	storage := newTestStorage(t)
	evt := &nostr.Event{CreatedAt: nostr.Now(), Kind: 1, Tags: nostr.Tags{}, Content: "note"}
	if err := evt.Sign(nostr.GeneratePrivateKey()); err != nil {
		t.Fatalf("failed to sign: %v", err)
	}

	if err := storage.AddPayment(evt.ID, 100, evt); err != nil {
		t.Fatalf("first payment: %v", err)
	}
	if err := storage.AddPayment(evt.ID, 250, nil); err != nil {
		t.Fatalf("second payment: %v", err)
	}

	post, _ := storage.GetPost(evt.ID)
	if len(post.Payments) != 2 {
		t.Fatalf("recorded %d payments, want 2", len(post.Payments))
	}
	if post.Payments[0].Sats != 100 || post.Payments[1].Sats != 250 {
		t.Errorf("recorded %v, want 100 then 250", post.Payments)
	}
	if post.TotalSatsPaid != 350 {
		t.Errorf("total = %d, want 350", post.TotalSatsPaid)
	}
	for i, p := range post.Payments {
		if p.At.IsZero() {
			t.Errorf("payment %d has no date, so it can never decay", i)
		}
	}
}

// The history has to survive a restart, or every note silently resets to
// full weight the next time the relay boots.
func TestPaymentHistorySurvivesReload(t *testing.T) {
	storage := newTestStorage(t)
	paidAt := time.Now().Add(-2 * rankHalfLife)
	id := seedPaidPost(t, storage, 400, paidAt)

	// Force a write, since the backdating above bypassed AddPayment's save.
	if err := storage.AddPayment(id, 1, nil); err != nil {
		t.Fatalf("failed to save: %v", err)
	}

	reopened, err := NewStorage(storage.dataFile)
	if err != nil {
		t.Fatalf("failed to reopen: %v", err)
	}

	post, exists := reopened.GetPost(id)
	if !exists {
		t.Fatal("the post did not survive the restart")
	}
	if len(post.Payments) != 2 {
		t.Fatalf("kept %d payments across a restart, want 2", len(post.Payments))
	}
	if got := post.Payments[0].At.UTC().Truncate(time.Second); !got.Equal(paidAt.UTC().Truncate(time.Second)) {
		t.Errorf("the old payment came back dated %s, want %s", got, paidAt.UTC().Truncate(time.Second))
	}
	// And it is still faded, rather than silently restored to full weight.
	if post.score(time.Now()) > 110 {
		t.Errorf("score after reload = %.1f; the old 400 sats came back at full weight",
			post.score(time.Now()))
	}
}

// What the ledger serves has to agree with the order it serves it in, since
// the whole point of publishing the weight is that the order can be checked.
func TestLedgerWeightsMatchTheOrder(t *testing.T) {
	storage := newTestStorage(t)
	now := time.Now()

	seedPaidPost(t, storage, 500, now.Add(-6*rankHalfLife))
	fresh := seedPaidPost(t, storage, 100, now)

	entries := storage.Ledger()
	if len(entries) != 2 {
		t.Fatalf("ledger has %d entries, want 2", len(entries))
	}

	if entries[0].ID != fresh {
		t.Errorf("the fresh 100 should lead; got the %d-sat note first", entries[0].SatsPaid)
	}
	if entries[0].Weight <= entries[1].Weight {
		t.Errorf("weights %d then %d do not descend with the order",
			entries[0].Weight, entries[1].Weight)
	}
	if entries[1].SatsPaid <= entries[0].SatsPaid {
		t.Error("this test is meant to have the larger payment ranked lower")
	}
	for i, e := range entries {
		if e.Rank != i+1 {
			t.Errorf("entry %d carries rank %d", i, e.Rank)
		}
		if e.Weight > e.SatsPaid {
			t.Errorf("weight %d exceeds the %d sats actually paid", e.Weight, e.SatsPaid)
		}
	}
}

// The websocket feed and the ledger are two views of one board, so they have to
// agree; a client reading notes over nostr and numbers over HTTP sees both.
func TestServedFeedMatchesTheLedgerOrder(t *testing.T) {
	storage := newTestStorage(t)
	now := time.Now()

	seedPaidPost(t, storage, 500, now.Add(-6*rankHalfLife))
	seedPaidPost(t, storage, 100, now)
	seedPaidPost(t, storage, 300, now.Add(-rankHalfLife))

	events := storage.QueryPosts(context.Background(), nostr.Filter{Kinds: []int{1}})
	entries := storage.Ledger()

	if len(events) != len(entries) {
		t.Fatalf("feed served %d notes, ledger listed %d", len(events), len(entries))
	}
	for i := range events {
		if events[i].ID != entries[i].ID {
			t.Errorf("position %d: feed has %s, ledger has %s",
				i, short(events[i].ID, 8), short(entries[i].ID, 8))
		}
	}
}
