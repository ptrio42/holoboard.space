package main

import (
	"testing"
	"time"
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
