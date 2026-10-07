package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/btcsuite/btcd/chaincfg"
	"github.com/nbd-wtf/go-nostr"
)

func TestPrimalAuthorInvoiceDescriptionCompatibility(t *testing.T) {
	const metadata = `[["text/plain","sats for TestAuthor@primal.net"]]`
	const legacy = `[["text/plain","sats for TestAuthor"]]`
	for _, test := range []struct {
		name, domain, callback, metadata, description string
		amount                                        int64
		publicZap, useZapDescription                  bool
		want                                          int
	}{
		{name: "ordinary Primal invoice", description: legacy, want: 200},
		{name: "standard metadata remains accepted", description: metadata, want: 200},
		{name: "wrong amount remains rejected", description: legacy, amount: 22000, want: 502},
		{name: "another recipient remains rejected", description: `[["text/plain","sats for SomeoneElse"]]`, want: 502},
		{name: "another lookup host cannot enable compatibility", domain: "wallet.example", description: legacy, want: 502},
		{name: "another callback host cannot enable compatibility", callback: "https://wallet.example/lnurlp/TestAuthor/callback", description: legacy, want: 502},
		{name: "another callback recipient cannot enable compatibility", callback: "https://primal.net/lnurlp/SomeoneElse/callback", description: legacy, want: 502},
		{name: "changed metadata cannot enable compatibility", metadata: `[["text/plain","Another payment"]]`, description: legacy, want: 502},
		{name: "public zap never uses ordinary compatibility", description: legacy, publicZap: true, want: 502},
		{name: "public zap retains its signed description", publicZap: true, useZapDescription: true, want: 200},
	} {
		t.Run(test.name, func(t *testing.T) {
			support, note, _ := supportFixture(t)
			domain := test.domain
			if domain == "" {
				domain = "primal.net"
			}
			callback := test.callback
			if callback == "" {
				callback = "https://primal.net/lnurlp/TestAuthor/callback"
			}
			advertised := test.metadata
			if advertised == "" {
				advertised = metadata
			}
			key := nostr.GeneratePrivateKey()
			if err := note.Sign(key); err != nil {
				t.Fatal(err)
			}
			if err := support.storage.AddPayment(note.ID, 1, note); err != nil {
				t.Fatal(err)
			}
			profile := &nostr.Event{Kind: 0, CreatedAt: nostr.Now(), Tags: nostr.Tags{}, Content: `{"lud16":"TestAuthor@` + domain + `"}`}
			if err := profile.Sign(key); err != nil {
				t.Fatal(err)
			}
			support.profile = func(context.Context, string, []string) (*nostr.Event, error) { return profile, nil }
			support.client.Transport = supportTransport(func(request *http.Request) (*http.Response, error) {
				var response any
				if strings.HasPrefix(request.URL.Path, "/.well-known/") {
					response = map[string]any{"tag": "payRequest", "callback": callback, "metadata": advertised, "minSendable": 1000, "maxSendable": 100000000, "allowsNostr": true, "nostrPubkey": note.PubKey}
				} else {
					description := test.description
					if test.useZapDescription {
						description = request.URL.Query().Get("nostr")
					}
					amount := test.amount
					if amount == 0 {
						amount = 21000
					}
					response = map[string]any{"pr": mintInvoice(t, amount, description, &chaincfg.MainNetParams)}
				}
				encoded, _ := json.Marshal(response)
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(encoded))), Header: make(http.Header)}, nil
			})
			body := map[string]any{"note": note.ID, "amount_sats": 21}
			if test.publicZap {
				zap := &nostr.Event{Kind: 9734, CreatedAt: nostr.Now(), Tags: nostr.Tags{{"p", note.PubKey}, {"e", note.ID}, {"amount", "21000"}, {"relays", "wss://relay.example"}}}
				if err := zap.Sign(nostr.GeneratePrivateKey()); err != nil {
					t.Fatal(err)
				}
				body["zap_request"] = zap
			}
			response := supportPost(t, support.Handler(), "/api/support/invoice", body)
			if response.Code != test.want {
				t.Fatalf("status %d, want %d: %s", response.Code, test.want, response.Body.String())
			}
			post, _ := support.storage.GetPost(note.ID)
			if post.TotalSatsPaid != 1 || len(post.Payments) != 1 {
				t.Fatal("preparing author invoice affected ranking")
			}
		})
	}
}

func TestPrimalDescriptionCompatibilityRequiresExactEndpoint(t *testing.T) {
	const endpoint = "https://primal.net/.well-known/lnurlp/TestAuthor"
	const callback = "https://primal.net/lnurlp/TestAuthor/callback"
	const metadata = `[["text/plain","sats for TestAuthor@primal.net"]]`
	for _, test := range []struct{ endpoint, callback string }{
		{"http://primal.net/.well-known/lnurlp/TestAuthor", callback},
		{endpoint, "http://primal.net/lnurlp/TestAuthor/callback"},
		{endpoint + "?different=1", callback},
		{endpoint, callback + "?different=1"},
		{endpoint, "https://primal.net.evil.example/lnurlp/TestAuthor/callback"},
		{"https://primal.net/.well-known/lnurlp/AnotherAuthor", callback},
		{"https://primal.net/other/TestAuthor", callback},
	} {
		if description := primalInvoiceDescription(test.endpoint, test.callback, metadata); description != "" {
			t.Fatalf("unexpected compatibility for %s and %s", test.endpoint, test.callback)
		}
	}
}
