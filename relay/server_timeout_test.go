package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/fiatjaf/khatru"
)

// TestSlowHandlerResponseSurvives pins the patch in third_party/khatru.
//
// khatru's Start sets the http.Server's write timeout, and upstream ships two
// seconds. Minting a Lightning invoice is a round trip to a wallet over nostr
// and regularly takes longer than that, so the server cut the connection
// mid-response: the invoice was created and stored, and the caller got a 502
// from the proxy with nothing to explain it. Users reported it as
// "502 when trying to get invoice".
//
// This test drives a real khatru server rather than httptest, because
// httptest.NewRecorder never applies the timeout that caused the bug.
func TestSlowHandlerResponseSurvives(t *testing.T) {
	const handlerDelay = 3 * time.Second // longer than khatru's stock 2s

	relay := khatru.NewRelay()
	relay.Router().HandleFunc("/slow", func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(handlerDelay)
		writeJSON(w, http.StatusOK, map[string]string{"minted": "yes"})
	})

	started := make(chan bool)
	go func() {
		if err := relay.Start("127.0.0.1", 0, started); err != nil {
			t.Errorf("relay stopped: %v", err)
		}
	}()
	<-started
	t.Cleanup(func() { relay.Shutdown(context.Background()) })

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://%s/slow", relay.Addr))
	if err != nil {
		t.Fatalf("the response never arrived, which is the bug: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("status %d, want 200", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("the body was cut off: %v", err)
	}

	var decoded map[string]string
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("body was not complete JSON (%q): %v", body, err)
	}
	if decoded["minted"] != "yes" {
		t.Errorf("body = %v, want the handler's own response", decoded)
	}
}
