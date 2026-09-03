package main

import (
	"strings"
	"testing"
	"time"
)

// The reply is the only thing a person sees after asking for an invoice, so it
// has to carry the invoice in a form a wallet can be handed, and say the amount
// before anyone squints at a bolt11 to work it out.
func TestInvoiceMessage(t *testing.T) {
	invoice := &Invoice{
		PaymentRequest: "lnbc10u1pexamplepaymentrequest",
		AmountSats:     1000,
		ExpiresAt:      time.Date(2026, time.September, 2, 21, 23, 0, 0, time.UTC),
	}

	message := invoiceMessage(invoice)
	t.Logf("the reply reads:\n%s", message)

	if !strings.Contains(message, "lightning:"+invoice.PaymentRequest) {
		t.Error("no lightning: URI, so nothing for a client to hand to a wallet")
	}
	if strings.Count(message, invoice.PaymentRequest) != 2 {
		t.Errorf("the invoice appears %d times, want twice: once as a URI and once to copy",
			strings.Count(message, invoice.PaymentRequest))
	}
	if !strings.Contains(message, "1000 sats") {
		t.Error("the amount is not stated in words")
	}
	// The formatting verbs and their arguments have to line up, which is easy
	// to get wrong when three of the four are strings.
	if !strings.Contains(message, "21:23 UTC on 2 September") {
		t.Errorf("expiry not rendered as a time; message was:\n%s", message)
	}
	if strings.Contains(message, "%!") {
		t.Errorf("a formatting verb went unfilled:\n%s", message)
	}
}
