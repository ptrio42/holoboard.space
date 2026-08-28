package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestSaveLeavesNoTempFile pins the atomic write. A leftover .tmp is harmless
// on its own, but it means the rename did not happen, which is the whole point.
func TestSaveLeavesNoTempFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "relay_data.json")

	storage, err := NewStorage(path)
	if err != nil {
		t.Fatalf("failed to create storage: %v", err)
	}
	seedPaidNote(t, storage, "a note", 21, time.Now())

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("failed to read dir: %v", err)
	}
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) == ".tmp" {
			t.Errorf("temp file %s survived the save", entry.Name())
		}
	}
	if len(entries) != 1 {
		t.Errorf("directory holds %d files, want just the ledger", len(entries))
	}
}

// TestSaveReplacesRatherThanTruncates is the failure this guards against. The
// old code wrote straight onto the live file, so a process dying mid-write left
// invalid JSON that load() refuses, and main.go turns that refusal into a fatal
// on the next boot. With a rename, a reader sees either the old file or the new
// one, never a half of either.
func TestSaveReplacesRatherThanTruncates(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "relay_data.json")

	storage, err := NewStorage(path)
	if err != nil {
		t.Fatalf("failed to create storage: %v", err)
	}

	first := seedPaidNote(t, storage, "first", 10, time.Now())
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read ledger: %v", err)
	}

	second := seedPaidNote(t, storage, "second", 99, time.Now())
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read ledger: %v", err)
	}

	for name, content := range map[string][]byte{"before": before, "after": after} {
		var parsed map[string]any
		if err := json.Unmarshal(content, &parsed); err != nil {
			t.Errorf("ledger %s the second save is not valid JSON: %v", name, err)
		}
	}

	// And the new content actually landed.
	reloaded, err := NewStorage(path)
	if err != nil {
		t.Fatalf("failed to reload storage: %v", err)
	}
	if _, ok := reloaded.GetPost(first); !ok {
		t.Error("first note missing after reload")
	}
	if _, ok := reloaded.GetPost(second); !ok {
		t.Error("second note missing after reload")
	}
}

// TestSaveSurvivesAStaleTempFile covers the leftover from a previous crash.
func TestSaveSurvivesAStaleTempFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "relay_data.json")

	if err := os.WriteFile(path+".tmp", []byte("{ truncated garbage"), 0644); err != nil {
		t.Fatalf("failed to plant a stale temp file: %v", err)
	}

	storage, err := NewStorage(path)
	if err != nil {
		t.Fatalf("failed to create storage: %v", err)
	}
	id := seedPaidNote(t, storage, "a note", 21, time.Now())

	reloaded, err := NewStorage(path)
	if err != nil {
		t.Fatalf("failed to reload storage: %v", err)
	}
	if _, ok := reloaded.GetPost(id); !ok {
		t.Error("note missing after a save that had to overwrite a stale temp file")
	}
}

// TestMentionWatermarkSurvivesRestart is the point of persisting it at all.
func TestMentionWatermarkSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "relay_data.json")

	storage, err := NewStorage(path)
	if err != nil {
		t.Fatalf("failed to create storage: %v", err)
	}
	if storage.MentionWatermark() != 0 {
		t.Errorf("a fresh board should have no watermark, got %d", storage.MentionWatermark())
	}

	if err := storage.AdvanceMentionWatermark(1_700_000_000); err != nil {
		t.Fatalf("failed to advance watermark: %v", err)
	}
	// Never rewinds, whatever order events arrive in.
	if err := storage.AdvanceMentionWatermark(1_600_000_000); err != nil {
		t.Fatalf("failed on a backwards advance: %v", err)
	}
	if got := storage.MentionWatermark(); got != 1_700_000_000 {
		t.Errorf("watermark = %d, want it to hold at 1700000000", got)
	}

	reloaded, err := NewStorage(path)
	if err != nil {
		t.Fatalf("failed to reload storage: %v", err)
	}
	if got := reloaded.MentionWatermark(); got != 1_700_000_000 {
		t.Errorf("watermark after restart = %d, want 1700000000", got)
	}
}

func TestMentionResumePoint(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	floor := now.Add(-maxMentionBacklog).Unix()

	cases := []struct {
		name      string
		watermark int64
		want      int64
	}{
		{"no watermark starts at the backlog floor", 0, floor},
		{"a recent watermark is used as is", floor + 3600, floor + 3600},
		{"an ancient watermark is clamped", 1, floor},
		{"a negative watermark is ignored", -5, floor},
		{"a watermark from the future is left alone", now.Unix() + 60, now.Unix() + 60},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := mentionResumePoint(c.watermark, now); got != c.want {
				t.Errorf("mentionResumePoint(%d) = %d, want %d", c.watermark, got, c.want)
			}
		})
	}
}

// TestQuiesceReturnsWhenSavesAreDone is a smoke test: it must not deadlock, and
// it must not return while the lock is held elsewhere.
func TestQuiesceReturnsWhenSavesAreDone(t *testing.T) {
	storage := newTestStorage(t)
	seedPaidNote(t, storage, "a note", 21, time.Now())

	done := make(chan struct{})
	go func() {
		storage.Quiesce()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Quiesce did not return on an idle storage")
	}
}

// TestDMWatermarkSurvivesRestart pins the fix for the worst thing this relay
// has actually done: on its first Fly deploy the DM monitor subscribed with a
// Limit and no Since, so it pulled months-old PROMOTE requests off a fresh
// volume and answered each one with a newly minted Lightning invoice.
func TestDMWatermarkSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "relay_data.json")

	storage, err := NewStorage(path)
	if err != nil {
		t.Fatalf("failed to create storage: %v", err)
	}
	if storage.DMWatermark() != 0 {
		t.Errorf("a fresh board should have no DM watermark, got %d", storage.DMWatermark())
	}

	if err := storage.AdvanceDMWatermark(1_700_000_000); err != nil {
		t.Fatalf("failed to advance: %v", err)
	}
	if err := storage.AdvanceDMWatermark(1_600_000_000); err != nil {
		t.Fatalf("failed on a backwards advance: %v", err)
	}
	if got := storage.DMWatermark(); got != 1_700_000_000 {
		t.Errorf("watermark = %d, want it to hold", got)
	}

	reloaded, err := NewStorage(path)
	if err != nil {
		t.Fatalf("failed to reload: %v", err)
	}
	if got := reloaded.DMWatermark(); got != 1_700_000_000 {
		t.Errorf("watermark after restart = %d, want 1700000000", got)
	}
	// The two watermarks must not share storage.
	if reloaded.MentionWatermark() != 0 {
		t.Errorf("mention watermark = %d, want 0; the two got crossed",
			reloaded.MentionWatermark())
	}
}

// TestDMBacklogIsShorterThanMentions: answering a stale mention costs a reply,
// answering a stale PROMOTE costs an invoice, so DMs look back less far.
func TestDMBacklogIsShorterThanMentions(t *testing.T) {
	if maxDMBacklog >= maxMentionBacklog {
		t.Errorf("DM backlog %s should be shorter than the mention backlog %s",
			maxDMBacklog, maxMentionBacklog)
	}

	now := time.Unix(1_800_000_000, 0)
	// A watermark older than the DM backlog must be clamped, not honoured.
	ancient := now.Add(-30 * 24 * time.Hour).Unix()
	got := resumePoint(ancient, now, maxDMBacklog)
	if got != now.Add(-maxDMBacklog).Unix() {
		t.Errorf("resumePoint clamped to %d, want %d", got, now.Add(-maxDMBacklog).Unix())
	}
}
