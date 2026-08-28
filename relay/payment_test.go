package main

import (
	"testing"

	"github.com/nbd-wtf/go-nostr/nip19"
)

func TestParsePromoteCommand(t *testing.T) {
	// Create test event ID
	testHexID := "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"

	// Encode to note format for testing
	noteEncoded, err := nip19.EncodeNote(testHexID)
	if err != nil {
		t.Fatalf("Failed to encode note: %v", err)
	}

	// Encode to nevent format for testing
	neventEncoded, err := nip19.EncodeEvent(testHexID, []string{}, "")
	if err != nil {
		t.Fatalf("Failed to encode nevent: %v", err)
	}

	tests := []struct {
		name       string
		content    string
		wantID     string
		wantAmount int64
		wantOk     bool
	}{
		{
			name:       "valid promote command - hex",
			content:    "PROMOTE 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
			wantID:     "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
			wantAmount: 0,
			wantOk:     true,
		},
		{
			name:       "valid promote command - hex with amount",
			content:    "PROMOTE 21 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
			wantID:     "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
			wantAmount: 21,
			wantOk:     true,
		},
		{
			name:       "valid promote command - hex lowercase",
			content:    "promote 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
			wantID:     "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
			wantAmount: 0,
			wantOk:     true,
		},
		{
			name:       "valid promote command - hex with extra whitespace",
			content:    "  PROMOTE   1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef  ",
			wantID:     "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
			wantAmount: 0,
			wantOk:     true,
		},
		{
			name:       "valid promote command - note1 format",
			content:    "PROMOTE " + noteEncoded,
			wantID:     "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
			wantAmount: 0,
			wantOk:     true,
		},
		{
			name:       "valid promote command - note1 format with amount",
			content:    "PROMOTE 100 " + noteEncoded,
			wantID:     "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
			wantAmount: 100,
			wantOk:     true,
		},
		{
			name:       "valid promote command - nevent1 format",
			content:    "PROMOTE " + neventEncoded,
			wantID:     "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
			wantAmount: 0,
			wantOk:     true,
		},
		{
			name:       "valid promote command - nevent1 format with amount",
			content:    "PROMOTE 500 " + neventEncoded,
			wantID:     "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
			wantAmount: 500,
			wantOk:     true,
		},
		{
			name:       "valid promote command - nostr:note1 format",
			content:    "PROMOTE nostr:" + noteEncoded,
			wantID:     "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
			wantAmount: 0,
			wantOk:     true,
		},
		{
			name:       "valid promote command - nostr:nevent1 format",
			content:    "PROMOTE nostr:" + neventEncoded,
			wantID:     "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
			wantAmount: 0,
			wantOk:     true,
		},
		{
			name:       "valid promote command - nostr:nevent1 format with amount",
			content:    "PROMOTE 1000 nostr:" + neventEncoded,
			wantID:     "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
			wantAmount: 1000,
			wantOk:     true,
		},
		{
			name:       "invalid command - wrong keyword",
			content:    "BOOST abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
			wantID:     "",
			wantAmount: 0,
			wantOk:     false,
		},
		{
			name:       "invalid command - too short ID",
			content:    "PROMOTE abc123",
			wantID:     "",
			wantAmount: 0,
			wantOk:     false,
		},
		{
			name:       "invalid command - non-hex characters",
			content:    "PROMOTE xyz1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
			wantID:     "",
			wantAmount: 0,
			wantOk:     false,
		},
		{
			name:       "invalid command - missing post ID",
			content:    "PROMOTE",
			wantID:     "",
			wantAmount: 0,
			wantOk:     false,
		},
		{
			name:       "invalid command - zero amount",
			content:    "PROMOTE 0 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
			wantID:     "",
			wantAmount: 0,
			wantOk:     false,
		},
		{
			name:       "invalid command - negative amount",
			content:    "PROMOTE -100 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
			wantID:     "",
			wantAmount: 0,
			wantOk:     false,
		},
		{
			name:       "invalid command - invalid amount",
			content:    "PROMOTE abc 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
			wantID:     "",
			wantAmount: 0,
			wantOk:     false,
		},
		{
			name:       "invalid command - too many arguments",
			content:    "PROMOTE 100 abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab extra",
			wantID:     "",
			wantAmount: 0,
			wantOk:     false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotID, gotAmount, gotOk := ParsePromoteCommand(tt.content)
			if gotID != tt.wantID {
				t.Errorf("ParsePromoteCommand() gotID = %v, want %v", gotID, tt.wantID)
			}
			if gotAmount != tt.wantAmount {
				t.Errorf("ParsePromoteCommand() gotAmount = %v, want %v", gotAmount, tt.wantAmount)
			}
			if gotOk != tt.wantOk {
				t.Errorf("ParsePromoteCommand() gotOk = %v, want %v", gotOk, tt.wantOk)
			}
		})
	}
}

func TestExtractAmountFromInvoice(t *testing.T) {
	tests := []struct {
		name     string
		bolt11   string
		wantSats int64
	}{
		{
			name:     "empty invoice",
			bolt11:   "",
			wantSats: 0,
		},
		{
			name:     "10 nano-bitcoin = 1 sat",
			bolt11:   "lnbc10n1...",
			wantSats: 1,
		},
		{
			name:     "100 nano-bitcoin = 10 sats",
			bolt11:   "lnbc100n1...",
			wantSats: 10,
		},
		{
			name:     "1000 nano-bitcoin = 100 sats",
			bolt11:   "lnbc1000n1...",
			wantSats: 100,
		},
		{
			name:     "1 micro-bitcoin = 100 sats",
			bolt11:   "lnbc1u1...",
			wantSats: 100,
		},
		{
			name:     "10 micro-bitcoin = 1000 sats",
			bolt11:   "lnbc10u1...",
			wantSats: 1000,
		},
		{
			name:     "1 milli-bitcoin = 100,000 sats",
			bolt11:   "lnbc1m1...",
			wantSats: 100000,
		},
		{
			name:     "6 nano-bitcoin = 600 millisats = 0 sats (rounds down)",
			bolt11:   "lnbc6n1...",
			wantSats: 0,
		},
		{
			name:     "60 nano-bitcoin = 6000 millisats = 6 sats",
			bolt11:   "lnbc60n1...",
			wantSats: 6,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ExtractAmountFromInvoice(tt.bolt11)
			if got != tt.wantSats {
				t.Errorf("ExtractAmountFromInvoice() = %v, want %v", got, tt.wantSats)
			}
		})
	}
}
