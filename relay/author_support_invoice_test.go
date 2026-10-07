package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/ecdsa"
	"github.com/btcsuite/btcd/btcutil/bech32"
	"github.com/btcsuite/btcd/chaincfg"
	"github.com/btcsuite/btcd/chaincfg/chainhash"
	"github.com/lightningnetwork/lnd/lnwire"
	"github.com/lightningnetwork/lnd/zpay32"
	"github.com/nbd-wtf/go-nostr"
)

func TestAuthorInvoiceAcceptsOrdinaryDescriptionsAndBindsPublicZaps(t *testing.T) {
	for _, test := range []struct {
		name, description                                      string
		plain, publicZap, exactZap, wrongAmount, missingAmount bool
		expired, testnet, badSignature, malformed              bool
		want                                                   int
	}{
		{name: "ordinary empty description", plain: true, want: 200},
		{name: "ordinary plain description", plain: true, description: "Support the author", want: 200},
		{name: "ordinary metadata hash", description: `[["text/plain","Support"]]`, want: 200},
		{name: "ordinary provider description hash", description: "Provider's payment description", want: 200},
		{name: "ordinary Primal description variant", description: `[["text/plain","sats for TestAuthor"]]`, want: 200},
		{name: "wrong plain invoice amount", plain: true, wrongAmount: true, want: 502},
		{name: "wrong hashed invoice amount", wrongAmount: true, want: 502},
		{name: "missing invoice amount", plain: true, missingAmount: true, want: 502},
		{name: "expired plain invoice", plain: true, expired: true, want: 502},
		{name: "wrong invoice network", plain: true, testnet: true, want: 502},
		{name: "invalid invoice signature", plain: true, badSignature: true, want: 502},
		{name: "malformed invoice", malformed: true, want: 502},
		{name: "public zap rejects empty description", publicZap: true, plain: true, want: 502},
		{name: "public zap rejects plain request JSON", publicZap: true, plain: true, exactZap: true, want: 502},
		{name: "public zap rejects metadata hash", publicZap: true, description: `[["text/plain","Support"]]`, want: 502},
		{name: "public zap rejects another description hash", publicZap: true, description: "Another zap request", want: 502},
		{name: "public zap accepts exact signed request hash", publicZap: true, exactZap: true, want: 200},
		{name: "public zap rejects wrong amount with correct request hash", publicZap: true, exactZap: true, wrongAmount: true, want: 502},
	} {
		t.Run(test.name, func(t *testing.T) {
			a, note, provider := supportFixture(t)
			metadataTransport := a.client.Transport
			var issued string
			proof := [32]byte{42}
			paymentHash := sha256.Sum256(proof[:])
			a.client.Transport = supportTransport(func(request *http.Request) (*http.Response, error) {
				if strings.HasPrefix(request.URL.Path, "/.well-known/") {
					return metadataTransport.RoundTrip(request)
				}
				if request.URL.Host != "wallet.example" || request.URL.Path != "/pay" {
					t.Fatalf("unexpected author invoice callback: %s", request.URL)
				}
				description := test.description
				if test.exactZap {
					description = request.URL.Query().Get("nostr")
				}
				options := []func(*zpay32.Invoice){}
				if test.plain {
					options = append(options, zpay32.Description(description))
				} else {
					options = append(options, zpay32.DescriptionHash(sha256.Sum256([]byte(description))))
				}
				if !test.missingAmount {
					amount := lnwire.MilliSatoshi(21000)
					if test.wrongAmount {
						amount++
					}
					options = append(options, zpay32.Amount(amount))
				}
				created := time.Now()
				if test.expired {
					created = created.Add(-2 * time.Hour)
				}
				network := &chaincfg.MainNetParams
				if test.testnet {
					network = &chaincfg.TestNet3Params
				}
				key, err := btcec.NewPrivateKey()
				if err != nil {
					t.Fatal(err)
				}
				options = append(options, zpay32.Destination(key.PubKey()))
				invoice, err := zpay32.NewInvoice(network, paymentHash, created, options...)
				if err != nil {
					t.Fatal(err)
				}
				issued, err = invoice.Encode(zpay32.MessageSigner{SignCompact: func(message []byte) ([]byte, error) {
					return ecdsa.SignCompact(key, chainhash.HashB(message), true), nil
				}})
				if err != nil {
					t.Fatal(err)
				}
				if test.badSignature {
					hrp, words, err := bech32.DecodeNoLimit(issued)
					if err != nil {
						t.Fatal(err)
					}
					words[len(words)-104] ^= 1
					issued, err = bech32.Encode(hrp, words)
					if err != nil {
						t.Fatal(err)
					}
				}
				if test.malformed {
					issued = "not-a-lightning-invoice"
				}
				encoded, _ := json.Marshal(map[string]string{"pr": issued})
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(encoded)))}, nil
			})
			body := map[string]any{"note": note.ID, "amount_sats": 21}
			if test.publicZap {
				zap := &nostr.Event{Kind: 9734, CreatedAt: nostr.Now(), Tags: nostr.Tags{{"p", note.PubKey}, {"e", note.ID}, {"amount", "21000"}, {"relays", "wss://relay.example"}}}
				if err := zap.Sign(nostr.GeneratePrivateKey()); err != nil {
					t.Fatal(err)
				}
				body["zap_request"] = zap
			}
			response := supportPost(t, a.Handler(), "/api/support/invoice", body)
			if response.Code != test.want {
				t.Fatalf("status %d, want %d: %s", response.Code, test.want, response.Body.String())
			}
			record, known := a.storage.GetAuthorInvoice(hex.EncodeToString(paymentHash[:]))
			if known != (test.want == 200) {
				t.Fatalf("issued invoice context saved=%v for status %d", known, test.want)
			}
			if known {
				if record.NoteID != note.ID || record.Author != note.PubKey || record.InvoiceDigest != authorInvoiceDigest(issued) {
					t.Fatal("issued invoice lost its original note, recipient or full invoice digest")
				}
				verified := supportPost(t, a.Handler(), "/api/support/verify", map[string]string{"invoice": issued, "preimage": hex.EncodeToString(proof[:])})
				if verified.Code != 200 {
					t.Fatalf("issued invoice proof rejected: %s", verified.Body.String())
				}
				proof[0]++
				forged := supportPost(t, a.Handler(), "/api/support/verify", map[string]string{"invoice": issued, "preimage": hex.EncodeToString(proof[:])})
				if forged.Code != 400 {
					t.Fatal("wrong payment preimage accepted")
				}
				if test.plain {
					request := zapRequestJSON(t, nostr.GeneratePrivateKey(), nostr.Tags{{"p", note.PubKey}, {"e", note.ID}, {"amount", "21000"}, {"relays", "wss://relay.example"}}, "")
					receipt := &nostr.Event{Kind: 9735, CreatedAt: nostr.Now(), Tags: nostr.Tags{{"p", note.PubKey}, {"e", note.ID}, {"bolt11", issued}, {"description", request}}}
					if err := receipt.Sign(provider); err != nil {
						t.Fatal(err)
					}
					converted := supportPost(t, a.Handler(), "/api/support/verify", map[string]any{"note": note.ID, "invoice": issued, "receipt": receipt})
					if converted.Code != 400 {
						t.Fatal("plain invoice accepted as a public zap receipt")
					}
				}
			}
			post, _ := a.storage.GetPost(note.ID)
			if post.TotalSatsPaid != 1 || len(post.Payments) != 1 {
				t.Fatal("preparing or verifying author invoice affected ranking")
			}
		})
	}
}
