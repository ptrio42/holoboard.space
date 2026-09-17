package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/fiatjaf/khatru"
)

func TestRelayDescriptionAcceptNegotiation(t *testing.T) {
	for _, tc := range []struct {
		name   string
		accept []string
		want   bool
	}{
		{"exact", []string{"application/nostr+json"}, true},
		{"list", []string{"application/json, application/nostr+json"}, true},
		{"parameters", []string{"application/nostr+json; charset=utf-8; q=0.9, */*;q=0.1"}, true},
		{"separate headers", []string{"application/json", "application/nostr+json"}, true},
		{"case", []string{"Application/Nostr+JSON"}, true},
		{"excluded", []string{"application/nostr+json;q=0, text/html"}, false},
		{"invalid quality", []string{"application/nostr+json;q=invalid"}, false},
		{"invalid range", []string{"application/nostr+json;q=2"}, false},
		{"unrequested", []string{"application/json"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			relay := khatru.NewRelay()
			relay.Info.Description = "Paid Nostr promotion board"
			request := httptest.NewRequest(http.MethodGet, "http://relay.example.com/", nil)
			for _, accept := range tc.accept {
				request.Header.Add("Accept", accept)
			}
			request.Header.Set("Origin", "https://client.example.com")
			response := httptest.NewRecorder()
			relay.ServeHTTP(response, request)
			if !tc.want {
				if response.Header().Get("Content-Type") == "application/nostr+json" {
					t.Fatal("returned unaccepted metadata")
				}
				return
			}
			if response.Code != http.StatusOK || !strings.Contains(strings.Join(response.Header().Values("Vary"), ","), "Accept") || response.Header().Get("Content-Type") != "application/nostr+json" || response.Header().Get("Access-Control-Allow-Origin") != "*" {
				t.Fatalf("metadata unavailable: %d %v", response.Code, response.Header())
			}
			var info struct {
				Description string `json:"description"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &info); err != nil {
				t.Fatal(err)
			}
			if info.Description != relay.Info.Description {
				t.Fatalf("lost description: %+v", info)
			}
		})
	}
}
