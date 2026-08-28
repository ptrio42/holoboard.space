package main

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// liveWalletAmountSats is what the live check asks for. Small on purpose: this
// mints a real invoice against a real wallet.
const liveWalletAmountSats = 21

// liveWalletBackend loads NWC_URI from the environment or from relay/.env and
// connects. It skips the test when no connection string is configured.
//
// Nothing in here prints the connection string or the secret inside it. The
// only values that reach the log are ones that are public by construction:
// relay URL, pubkeys, the Lightning address, and the bolt11 invoice, which
// exists to be handed out.
func liveWalletBackend(t *testing.T) *NWCBackend {
	t.Helper()

	// Gated deliberately. Once NWC_URI sits in relay/.env, an ungated test
	// would reach a real wallet and mint a real invoice on every plain
	// `go test ./...`, which is not something a default test run should do.
	if os.Getenv("NWC_LIVE") == "" {
		t.Skip("set NWC_LIVE=1 to run against the real wallet configured in relay/.env")
	}

	uri := os.Getenv("NWC_URI")
	if uri == "" {
		// Same loader main.go uses, so putting the URI in relay/.env is enough.
		if err := loadEnvFile(".env"); err != nil {
			t.Logf("could not read .env: %v", err)
		}
		uri = os.Getenv("NWC_URI")
	}
	if uri == "" {
		t.Skip("no NWC_URI configured; put one in relay/.env to run this against a real wallet")
	}

	backend, err := ParseNWCURI(uri)
	if err != nil {
		t.Fatalf("could not parse the configured NWC_URI: %v", err)
	}
	return backend
}

// TestNWCLiveWallet exercises the backend against a real wallet: reads its
// capabilities, mints an invoice, and looks that invoice back up.
//
//	cd relay && NWC_LIVE=1 go test -run TestNWCLiveWallet -v
func TestNWCLiveWallet(t *testing.T) {
	backend := liveWalletBackend(t)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	if err := backend.LoadInfo(ctx); err != nil {
		t.Fatalf("LoadInfo failed: %v", err)
	}

	t.Logf("wallet relay:        %s", backend.relayURL)
	t.Logf("wallet pubkey:       %s", backend.walletPubkey)
	t.Logf("our client pubkey:   %s", backend.clientPubkey)
	t.Logf("encryption in use:   %s", backend.encryptionScheme())
	t.Logf("methods advertised:  %s", strings.Join(backend.methods, " "))
	t.Logf("notifications:       %s", strings.Join(backend.notifications, " "))

	if addr := backend.LightningAddress(); addr != "" {
		t.Logf("lightning address:   %s  (this is what the zap flows need)", addr)
	} else {
		t.Log("lightning address:   not in the connection string; the zap flows need one separately")
	}

	if backend.SupportsNotifications() {
		t.Log("settlement:          wallet pushes payment_received, notifications will do the work")
	} else {
		t.Log("settlement:          wallet pushes nothing, the reconciler's polling will do the work")
	}

	invoice, err := backend.GenerateInvoice(ctx, liveWalletAmountSats, "holoboard live check")
	if err != nil {
		t.Fatalf("GenerateInvoice failed: %v", err)
	}

	if invoice.AmountSats != liveWalletAmountSats {
		t.Errorf("invoice amount = %d sats, want %d", invoice.AmountSats, liveWalletAmountSats)
	}
	if !strings.HasPrefix(strings.ToLower(invoice.PaymentRequest), "lnbc") {
		t.Errorf("payment request does not look like a mainnet bolt11: %q", invoice.PaymentRequest)
	}
	if !invoice.ExpiresAt.After(time.Now()) {
		t.Errorf("invoice expiry %v is not in the future", invoice.ExpiresAt)
	}

	t.Logf("minted invoice for %d sats, hash %s, expires %s",
		invoice.AmountSats, invoice.PaymentHash, invoice.ExpiresAt.Format(time.RFC3339))
	t.Logf("bolt11: %s", invoice.PaymentRequest)

	paid, amount, err := backend.CheckInvoice(ctx, invoice.PaymentHash)
	if err != nil {
		t.Fatalf("CheckInvoice failed: %v", err)
	}
	if paid {
		t.Error("a freshly minted invoice reports as already settled")
	}
	// The amount is advisory here. Coinos leaves it out of a lookup on a
	// pending invoice, so 0 is a legitimate answer and not a failure.
	switch amount {
	case 0:
		t.Log("lookup_invoice reports no amount for a pending invoice, which is fine; " +
			"the reconciler books the amount from storage")
	case liveWalletAmountSats:
		t.Log("lookup_invoice echoes the invoice amount back")
	default:
		t.Errorf("lookup_invoice amount = %d sats, want 0 or %d", amount, liveWalletAmountSats)
	}

	t.Log("lookup_invoice agrees the invoice is unpaid, which is the whole round trip working")
}

// TestNWCLiveWalletSettlement mints an invoice, waits for a human to pay it,
// and reports what each of the two detection paths did.
//
//	cd relay && NWC_LIVE=1 NWC_WAIT_FOR_PAYMENT=1 go test -run TestNWCLiveWalletSettlement -v -timeout 15m
//
// Skipped unless NWC_WAIT_FOR_PAYMENT is set, since it needs someone to pay.
func TestNWCLiveWalletSettlement(t *testing.T) {
	if os.Getenv("NWC_WAIT_FOR_PAYMENT") == "" {
		t.Skip("set NWC_WAIT_FOR_PAYMENT=1 to mint an invoice and wait for it to be paid")
	}

	backend := liveWalletBackend(t)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	if err := backend.LoadInfo(ctx); err != nil {
		t.Fatalf("LoadInfo failed: %v", err)
	}
	t.Logf("wallet advertises notifications: %v", backend.SupportsNotifications())

	// Start watching before minting, so a very fast payment cannot slip past.
	paidCh, err := backend.WatchInvoices(ctx)
	if err != nil {
		t.Fatalf("WatchInvoices failed: %v", err)
	}

	invoice, err := backend.GenerateInvoice(ctx, liveWalletAmountSats, "holoboard settlement check")
	if err != nil {
		t.Fatalf("GenerateInvoice failed: %v", err)
	}

	t.Logf("pay this %d sat invoice within 10 minutes:", invoice.AmountSats)
	t.Logf("%s", invoice.PaymentRequest)

	// Drop the bolt11 somewhere readable straight away. The test then blocks
	// for as long as it takes someone to pay, and Go holds test output until
	// the test ends, so without this there is no way to get at the invoice
	// while it still matters.
	if out := os.Getenv("NWC_INVOICE_OUT"); out != "" {
		if err := os.WriteFile(out, []byte(invoice.PaymentRequest+"\n"), 0o600); err != nil {
			t.Logf("could not write the invoice to %s: %v", out, err)
		} else {
			t.Logf("invoice also written to %s", out)
		}
	}

	// Do not stop at the first detection. Both paths are meant to work, and
	// returning on whichever fires first cannot tell "the notification never
	// arrived" apart from "polling happened to win the race". Once one path
	// reports, give the other a grace window, then say what each of them did.
	const grace = 45 * time.Second

	poll := time.NewTicker(3 * time.Second)
	defer poll.Stop()

	var (
		notified, polled bool
		graceCh          <-chan time.Time // stays nil until something reports
	)

wait:
	for !notified || !polled {
		select {
		case <-ctx.Done():
			t.Fatal("neither path detected the payment before the deadline")

		case <-graceCh:
			t.Log("grace window closed with only one path reporting")
			break wait

		case paid, ok := <-paidCh:
			if !ok {
				paidCh = nil // notification stream gone, polling carries on
				continue
			}
			if paid.PaymentHash != invoice.PaymentHash || notified {
				continue // a different invoice on the same wallet, or a repeat
			}
			notified = true
			t.Logf("NOTIFICATION path: %d sats at %s",
				paid.AmountSats, paid.PaidAt.Format(time.RFC3339))
			if graceCh == nil {
				graceCh = time.After(grace)
			}

		case <-poll.C:
			if polled {
				continue
			}
			settled, amount, err := backend.CheckInvoice(ctx, invoice.PaymentHash)
			if err != nil {
				t.Logf("lookup_invoice failed, will retry: %v", err)
				continue
			}
			if !settled {
				continue
			}
			polled = true
			t.Logf("POLLING path: settled, amount reported as %d sats", amount)
			if graceCh == nil {
				graceCh = time.After(grace)
			}
		}
	}

	switch {
	case notified && polled:
		t.Log("RESULT: both paths work. Settlement is instant through notifications, " +
			"with the reconciler's polling behind it as a backstop.")
	case notified:
		t.Log("RESULT: notifications work. Polling did not confirm inside the grace " +
			"window, which is odd but not harmful, since settlement is already instant.")
	case polled:
		t.Error("RESULT: only polling saw the payment. The wallet advertises " +
			"payment_received but nothing arrived, so in production settlement lags by " +
			"up to INVOICE_CHECK_SECONDS instead of landing instantly. Either the wallet " +
			"does not really send notifications on this connection, or the subscription " +
			"in watchOnce is wrong.")
	default:
		t.Fatal("neither path detected the payment")
	}
}

// TestParseNWCURINeverLeaksTheSecret pins the fix for a real leak: url.Parse
// embeds its whole input in the error it returns, and that input carries the
// wallet secret, so wrapping it put the secret into main.go's log.Fatalf and
// from there into the host's log stream.
func TestParseNWCURINeverLeaksTheSecret(t *testing.T) {
	const secret = "d34db33fd34db33fd34db33fd34db33fd34db33fd34db33fd34db33fd34db33f"
	const pubkey = "30bd172fc5295108b93de95516c811fabcfba0ec891e251645023329113d7643"

	malformed := []string{
		"nostr+walletconnect://" + pubkey + "?relay=wss://r&secret=" + secret + "\x7f",
		"nostr+walletconnect://%zz?relay=wss://r&secret=" + secret,
		"://" + pubkey + "?secret=" + secret,
		"nostr+walletconnect://short?relay=wss://r&secret=" + secret,
		"nostr+walletconnect://" + pubkey + "?secret=" + secret,
		"https://" + pubkey + "?relay=wss://r&secret=" + secret,
	}

	for _, uri := range malformed {
		_, err := ParseNWCURI(uri)
		if err == nil {
			continue // fine, it parsed; nothing to leak
		}
		if strings.Contains(err.Error(), secret) {
			t.Errorf("error message leaked the secret: %v", err)
		}
	}
}
