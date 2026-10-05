package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

func TestExistingCampaignAllocationSurvivesRestart(t *testing.T) {
	zero, custom := 0, 35
	for _, test := range []struct {
		name  string
		share *int
		want  int
	}{
		{"legacy", nil, 0},
		{"visibility only", &zero, 0},
		{"custom split", &custom, 35},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := newTestStorage(t)
			id := seedPaidNote(t, s, test.name, 210, time.Now())
			s.posts[id].AuthorShare = test.share
			if err := s.save(); err != nil {
				t.Fatal(err)
			}
			loaded, err := NewStorage(s.dataFile)
			if err != nil {
				t.Fatal(err)
			}
			rec := postPromote(t, PreviewHandler(loaded, NewPostFetcher(nil)), map[string]string{"note": id}, "1.2.3.4")
			var preview struct {
				AuthorShare int `json:"author_share"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &preview); err != nil {
				t.Fatal(err)
			}
			if rec.Code != 200 || preview.AuthorShare != test.want || loaded.CampaignEntries(time.Now())[0].AuthorShare != test.want {
				t.Fatalf("campaign or preview changed the allocation: %s", rec.Body.String())
			}
			requested := 70
			manager := NewInvoiceManager(NewMockLightningBackend(), loaded, nil, 1000)
			invoice, err := manager.GeneratePromotionInvoiceWithContact(context.Background(), id, 168, nil, "", nil, "", nil, &requested)
			if err != nil {
				t.Fatal(err)
			}
			pending, ok := loaded.GetPendingInvoice(invoice.PaymentHash)
			if !ok || pending.AuthorShare == nil || *pending.AuthorShare != test.want || pending.AmountSats != 168 {
				t.Fatalf("boost replaced campaign allocation or visibility amount: %+v", pending)
			}
		})
	}
}

func TestLegacyCampaignBoostAndRevivalPreservePublicQuoteAndAllocation(t *testing.T) {
	s, publisher, note := accountPublicationFixture(t)
	quote, err := publisher.BuildQuoteWithSplit(note, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	quote.Tags = quote.Tags[:2]
	if err := quote.Sign(publisher.relayPrivkey); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreditZapWithPublication(note.ID, 21, note, "initial", "initial", quote, nil); err != nil {
		t.Fatal(err)
	}
	// A pre-split record has no author_share field in its persisted JSON.
	s.posts[note.ID].AuthorShare = nil
	if err := s.save(); err != nil {
		t.Fatal(err)
	}
	first := s.posts[note.ID].FirstPromotedAt
	replacement, err := publisher.BuildQuoteWithSplit(note, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	for _, revive := range []bool{false, true} {
		loaded, err := NewStorage(s.dataFile)
		if err != nil {
			t.Fatal(err)
		}
		s = loaded
		if revive {
			for i := range s.posts[note.ID].Payments {
				s.posts[note.ID].Payments[i].At = time.Now().Add(-2 * 365 * 24 * time.Hour)
			}
			if s.posts[note.ID].weight(time.Now()) != 0 {
				t.Fatal("fixture must be expired before revival")
			}
			rec := postPromote(t, PreviewHandler(s, NewPostFetcher(nil)), map[string]string{"note": note.ID}, "1.2.3.4")
			var preview struct {
				Active      bool `json:"active"`
				AuthorShare int  `json:"author_share"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &preview); err != nil {
				t.Fatal(err)
			}
			if rec.Code != 200 || preview.Active || preview.AuthorShare != 0 {
				t.Fatalf("expired legacy preview changed its allocation: %s", rec.Body.String())
			}
		}
		share := 20
		invoice := &PendingInvoice{PostID: note.ID, PaymentHash: fmt.Sprint(revive), AmountSats: 168, Event: note, AuthorShare: &share}
		if err := s.AddPendingInvoice(invoice); err != nil {
			t.Fatal(err)
		}
		if _, err := s.SettleInvoiceWithPublication(invoice.PaymentHash, note, replacement, nil); err != nil {
			t.Fatal(err)
		}
		post, _ := s.GetPost(note.ID)
		if post.AuthorShare != nil || campaignAuthorShare(post) != 0 || !post.FirstPromotedAt.Equal(first) {
			t.Fatal("boost or revival changed legacy campaign metadata")
		}
		if len(s.accountPublications) != 1 || s.accountPublications[quotePublicationKey(note.ID)].Event.ID != quote.ID {
			t.Fatal("boost or revival replaced the public quote")
		}
	}
	loaded, err := NewStorage(s.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	post, _ := loaded.GetPost(note.ID)
	if post.AuthorShare != nil || loaded.CampaignEntries(time.Now())[0].AuthorShare != 0 || post.TotalSatsPaid != 357 {
		t.Fatal("restart changed the legacy default or credited amount")
	}
}

func TestWaitingRoomUsesGlobalRanksAndDistinctSorts(t *testing.T) {
	s := newTestStorage(t)
	for i := 0; i < 24; i++ {
		id := seedPaidNote(t, s, fmt.Sprint(i), int64(1000-i*10), time.Now())
		s.posts[id].FirstPromotedAt = time.Now().Add(time.Duration(i) * time.Minute)
	}
	entries := s.CampaignEntries(time.Now())
	if len(entries) != 24 || len(waitingEntries(entries, "top")) != 3 {
		t.Fatal("waiting room must contain only positions below 21")
	}
	if waitingEntries(entries, "top")[0].Rank != 22 || waitingEntries(entries, "new")[0].Rank != 24 {
		t.Fatal("sorts must preserve global ranks")
	}
	last, _ := s.GetPost(entries[23].ID)
	if err := s.AddPayment(last.PostID, 2000, last.Event); err != nil {
		t.Fatal(err)
	}
	for _, entry := range waitingEntries(s.CampaignEntries(time.Now()), "top") {
		if entry.ID == last.PostID {
			t.Fatal("promoted entry remains in waiting room")
		}
	}
	rec := httptest.NewRecorder()
	CampaignHandler(s)(rec, httptest.NewRequest("GET", "/api/board/campaigns?view=invalid", nil))
	if rec.Code != 400 {
		t.Fatalf("invalid view status = %d", rec.Code)
	}
}

func TestHotCountsOnlyRecentPromotionPayments(t *testing.T) {
	s := newTestStorage(t)
	id := seedPaidNote(t, s, "old campaign", 1000, time.Now())
	now := time.Now()
	s.posts[id].FirstPromotedAt = now.Add(-48 * time.Hour)
	s.posts[id].Payments[0].At = now.Add(-25 * time.Hour)
	post, _ := s.GetPost(id)
	if err := s.AddPayment(id, 21, post.Event); err != nil {
		t.Fatal(err)
	}
	entry := s.CampaignEntries(now.Add(time.Second))[0]
	if entry.HotSats != 21 {
		t.Fatalf("hot = %d, want 21", entry.HotSats)
	}
	if entry.FirstPaidAt != now.Add(-48*time.Hour).Unix() {
		t.Fatal("boost changed first promotion time")
	}
}

func TestQuoteZapMappingSurvivesReloadAndRemoval(t *testing.T) {
	s, publisher, note := accountPublicationFixture(t, "wss://relay.example")
	quote, err := publisher.BuildQuoteWithSplit(note, "", 30)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreditZapWithPublication(note.ID, 21, note, "zap", "hash", quote, publisher.Targets()); err != nil {
		t.Fatal(err)
	}
	loaded, err := NewStorage(s.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	if target, ok := loaded.GetPromotedNoteID(quote.ID); !ok || target != note.ID {
		t.Fatal("quote has no durable zap mapping")
	}
	if _, err := loaded.RemovePost(note.ID); err != nil {
		t.Fatal(err)
	}
	if target, ok := loaded.GetPromotedNoteID(quote.ID); !ok || target != note.ID {
		t.Fatal("removed quote lost its target")
	}
	if len(quote.Tags.GetAll([]string{"zap"})) != 2 {
		t.Fatal("quote must contain two zap recipients")
	}
}

func TestCampaignPaginationKeepsMainBoardAt21(t *testing.T) {
	s := newTestStorage(t)
	for i := 0; i < 46; i++ {
		seedPaidNote(t, s, fmt.Sprint(i), int64(1000-i), time.Now())
	}
	for _, test := range []struct {
		query                   string
		count, total, firstRank int
		more                    bool
	}{
		{"view=board", 21, 21, 1, false},
		{"view=top", 21, 25, 22, true},
		{"view=top&page=2", 4, 25, 43, false},
		{"view=board&page=2", 0, 21, 0, false},
	} {
		rec := httptest.NewRecorder()
		CampaignHandler(s)(rec, httptest.NewRequest("GET", "/api/board/campaigns?"+test.query, nil))
		var result struct {
			Entries []CampaignEntry `json:"entries"`
			Total   int             `json:"total"`
			HasMore bool            `json:"has_more"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if rec.Code != 200 || len(result.Entries) != test.count || result.Total != test.total || result.HasMore != test.more {
			t.Fatalf("%s: %s", test.query, rec.Body.String())
		}
		if test.count > 0 && result.Entries[0].Rank != test.firstRank {
			t.Fatal("global rank changed across pages")
		}
	}
}

func TestFirstSettledCampaignSplitSurvivesBoostAndRevival(t *testing.T) {
	s, publisher, note := accountPublicationFixture(t)
	for i, share := range []int{30, 70} {
		invoice := &PendingInvoice{PostID: note.ID, PaymentHash: fmt.Sprint(i), AmountSats: 21, Event: note, AuthorShare: &share}
		if err := s.AddPendingInvoice(invoice); err != nil {
			t.Fatal(err)
		}
		quote, err := publisher.BuildQuoteWithSplit(note, "", share)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.SettleInvoiceWithPublication(invoice.PaymentHash, note, quote, nil); err != nil {
			t.Fatal(err)
		}
	}
	post, _ := s.GetPost(note.ID)
	first := post.FirstPromotedAt
	if campaignAuthorShare(post) != 30 {
		t.Fatal("boost replaced campaign split")
	}
	for i := range s.posts[note.ID].Payments {
		s.posts[note.ID].Payments[i].At = time.Now().Add(-2 * 365 * 24 * time.Hour)
	}
	if s.posts[note.ID].weight(time.Now()) != 0 {
		t.Fatal("fixture must be expired")
	}
	if err := s.AddPayment(note.ID, 1, note); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewStorage(s.dataFile)
	if err != nil {
		t.Fatal(err)
	}
	post, _ = reloaded.GetPost(note.ID)
	if campaignAuthorShare(post) != 30 || !post.FirstPromotedAt.Equal(first) {
		t.Fatal("revival or restart changed campaign metadata")
	}
	stored, ok := reloaded.GetPromotedNoteID(reloaded.accountPublications[quotePublicationKey(note.ID)].Event.ID)
	if !ok || stored != note.ID || len(reloaded.accountPublications) != 1 {
		t.Fatal("boost created another public quote")
	}
}

func TestHotExcludesAppearanceFeeAndLegacyHistoryIsPreserved(t *testing.T) {
	s := newTestStorage(t)
	key := nostr.GeneratePrivateKey()
	note := &nostr.Event{Kind: 1, CreatedAt: nostr.Now(), Tags: nostr.Tags{}, Content: "Appearance"}
	if err := note.Sign(key); err != nil {
		t.Fatal(err)
	}
	invoice := &PendingInvoice{PostID: note.ID, PaymentHash: "appearance", AmountSats: 121, BillboardFee: 100, Billboard: &BillboardConfig{Template: "led", Color: "cyan", Size: "medium", Text: "Appearance"}}
	if err := s.AddPendingInvoice(invoice); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SettleInvoiceWithPublication(invoice.PaymentHash, note, nil, nil); err != nil {
		t.Fatal(err)
	}
	entry := s.CampaignEntries(time.Now())[0]
	if entry.HotSats != 21 || entry.SatsPaid != 21 {
		t.Fatal("appearance fee counted as visibility")
	}
	s.posts[note.ID].Payments = nil
	entry = s.CampaignEntries(time.Now())[0]
	if entry.HotSats != 21 {
		t.Fatal("legacy score disappeared from Hot")
	}
}
