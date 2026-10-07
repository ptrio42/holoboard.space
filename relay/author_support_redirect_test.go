package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func paymentRedirect(location string) *http.Response {
	return &http.Response{
		StatusCode: http.StatusFound,
		Header:     http.Header{"Location": []string{location}},
		Body:       io.NopCloser(strings.NewReader("")),
	}
}

func TestAuthorSupportFollowsPublicLightningAddressRedirect(t *testing.T) {
	a, note, _ := supportFixture(t)
	provider := a.client.Transport
	redirects := 0
	a.client.Transport = supportTransport(func(req *http.Request) (*http.Response, error) {
		if req.URL.Host == "wallet.example" && req.URL.Path == "/.well-known/lnurlp/author" {
			redirects++
			return paymentRedirect("https://provider.example/.well-known/lnurlp/recipient"), nil
		}
		return provider.RoundTrip(req)
	})
	response := supportPost(t, a.Handler(), "/api/support/invoice", map[string]any{"note": note.ID, "amount_sats": 21})
	if response.Code != http.StatusOK {
		t.Fatalf("redirected author invoice status %d: %s", response.Code, response.Body.String())
	}
	if redirects != 1 {
		t.Fatalf("expected one metadata redirect, got %d", redirects)
	}
}

func TestAuthorSupportRejectsUnsafeRedirectsBeforeRequest(t *testing.T) {
	for _, target := range []string{
		"http://provider.example/pay",
		"https://127.0.0.1/pay",
		"https://10.0.0.1/pay",
		"https://169.254.169.254/pay",
		"https://100.64.0.1/pay",
		"https://[::1]/pay",
		"https://[::ffff:127.0.0.1]/pay",
		"https://localhost/pay",
		"https://wallet.localhost/pay",
		"https://wallet.local/pay",
		"https://user:password@provider.example/pay",
		"https://provider.example:8080/pay",
	} {
		t.Run(target, func(t *testing.T) {
			a, _, _ := supportFixture(t)
			requests := 0
			a.client.Transport = supportTransport(func(req *http.Request) (*http.Response, error) {
				requests++
				return paymentRedirect(target), nil
			})
			var result any
			if err := a.readJSON(context.Background(), "https://wallet.example/pay", &result); err == nil {
				t.Fatal("unsafe redirect accepted")
			}
			if requests != 1 {
				t.Fatalf("contacted unsafe redirect target, requests = %d", requests)
			}
		})
	}
}

func TestAuthorSupportBoundsRedirectChain(t *testing.T) {
	for _, redirects := range []int{3, 4} {
		t.Run(fmt.Sprint(redirects), func(t *testing.T) {
			a, _, _ := supportFixture(t)
			requests := 0
			a.client.Transport = supportTransport(func(req *http.Request) (*http.Response, error) {
				requests++
				if requests <= redirects {
					return paymentRedirect(fmt.Sprintf("https://provider.example/step/%d", requests)), nil
				}
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"tag":"payRequest"}`))}, nil
			})
			var result struct{ Tag string }
			err := a.readJSON(context.Background(), "https://wallet.example/pay", &result)
			if redirects == 3 && (err != nil || result.Tag != "payRequest") {
				t.Fatalf("three public redirects failed: %v, %+v", err, result)
			}
			if redirects == 4 && err == nil {
				t.Fatal("fourth redirect accepted")
			}
			if requests != 4 {
				t.Fatalf("expected four requests, got %d", requests)
			}
		})
	}
}

func TestPaymentTransportRejectsPrivateDialAddresses(t *testing.T) {
	client := paymentHTTPClient()
	transport := client.Transport.(*http.Transport)
	defer transport.CloseIdleConnections()
	for _, target := range []string{"127.0.0.1:443", "10.0.0.1:443", "169.254.169.254:443", "100.64.0.1:443", "[::1]:443", "[::ffff:127.0.0.1]:443"} {
		connection, err := transport.DialContext(context.Background(), "tcp", target)
		if connection != nil {
			connection.Close()
		}
		if err == nil || !strings.Contains(err.Error(), "private address") {
			t.Errorf("private target %s was not blocked by DNS address validation: %v", target, err)
		}
	}
}
