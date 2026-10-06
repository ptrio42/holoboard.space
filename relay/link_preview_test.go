package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type previewRoundTripper func(*http.Request) (*http.Response, error)

func (f previewRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func previewResponse(r *http.Request, body, contentType string, status int) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {contentType}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}
}
func fixtureLinkPreviews(body string) *linkPreviews {
	s := newLinkPreviews()
	s.resolve = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("1.1.1.1")}}, nil
	}
	s.client.Transport = previewRoundTripper(func(r *http.Request) (*http.Response, error) { return previewResponse(r, body, "text/html", 200), nil })
	return s
}

func TestLinkPreviewMetadataFallbacksAndRelativeImages(t *testing.T) {
	base, _ := url.Parse("https://example.com/posts/one")
	body := `<head><title>HTML fallback</title><meta property="og:title" content="First &amp; trusted"><meta property="og:title" content="Second"><meta property="og:description" content=" A short   summary "><meta property="og:image" content="../cover.png"><meta property="og:url" content="javascript:alert(1)"></head>`
	preview, err := parseLinkPreview([]byte(body), base)
	if err != nil || preview.Title != "First & trusted" || preview.Description != "A short summary" || preview.ImageURL != "https://example.com/cover.png" || preview.URL != base.String() {
		t.Fatalf("incorrect metadata: %+v %v", preview, err)
	}
	preview, err = parseLinkPreview([]byte(`<head><title>Fallback &lt;script&gt;</title><meta name="description" content="Plain description"><meta property="og:image" content="http://127.0.0.1/private"></head>`), base)
	if err != nil || preview.Title != "Fallback <script>" || preview.Description != "Plain description" || preview.ImageURL != "" {
		t.Fatalf("unsafe or missing fallback: %+v %v", preview, err)
	}
	if _, err := parseLinkPreview([]byte(`<html><body>Nothing here</body></html>`), base); err == nil {
		t.Fatal("empty metadata must leave an ordinary link")
	}
	preview, err = parseLinkPreview([]byte(`<meta property="og:title" content="`+strings.Repeat("é", 500)+`"><meta property="og:description" content="`+strings.Repeat("a", 1000)+`">`), base)
	if err != nil || len([]rune(preview.Title)) != 240 || len(preview.Description) != 600 {
		t.Fatal("metadata must have bounded text sizes")
	}
}

func TestLinkPreviewBlocksPrivateURLsAndAddresses(t *testing.T) {
	for _, value := range []string{"file:///etc/passwd", "javascript:alert(1)", "https://user:secret@example.com", "https://example.com:444", "http://example.com:443", "http://localhost/", "http://host.local/", "http://127.0.0.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://10.1.2.3/", "http://169.254.169.254/", "http://100.64.0.1/", "http://198.18.0.1/", "http://192.0.2.1/", "http://[2001:db8::1]/"} {
		if _, err := publicPreviewURL(value); err == nil {
			t.Errorf("accepted unsafe URL %s", value)
		}
	}
	for _, value := range []string{"0.0.0.0", "192.168.1.1", "172.16.1.1", "224.0.0.1", "240.0.0.1", "::", "fc00::1", "fe80::1", "2002:7f00:1::1"} {
		if publicPreviewIP(net.ParseIP(value)) {
			t.Errorf("accepted unsafe address %s", value)
		}
	}
	for _, value := range []string{"1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"} {
		if !publicPreviewIP(net.ParseIP(value)) {
			t.Errorf("blocked public address %s", value)
		}
	}
	resolver := func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("1.1.1.1")}, {IP: net.ParseIP("127.0.0.1")}}, nil
	}
	if _, err := publicPreviewAddresses(context.Background(), "mixed.example", resolver); err == nil {
		t.Fatal("mixed DNS answers must be rejected")
	}
	s := newLinkPreviews()
	s.resolve = resolver
	if _, err := s.client.Get("https://mixed.example"); err == nil {
		t.Fatal("transport connected to an unsafe DNS answer")
	}
}

func TestLinkPreviewRejectsPrivateRedirectsAndRedirectLoops(t *testing.T) {
	for _, destination := range []string{"http://127.0.0.1/secret", "https://example.com/loop"} {
		s := fixtureLinkPreviews("")
		var calls int
		s.client.Transport = previewRoundTripper(func(r *http.Request) (*http.Response, error) {
			calls++
			response := previewResponse(r, "", "text/html", 302)
			response.Header.Set("Location", destination)
			return response, nil
		})
		if _, err := s.lookup(context.Background(), "https://example.com"); err == nil {
			t.Fatal("accepted unsafe redirect")
		}
		if destination == "http://127.0.0.1/secret" && calls != 1 {
			t.Fatal("contacted private redirect destination")
		}
		if calls > 4 {
			t.Fatal("exceeded three redirects")
		}
	}
}

func TestLinkPreviewBoundsBodiesAndRemovesPrivateThumbnail(t *testing.T) {
	for _, fixture := range []struct {
		body, contentType string
		status            int
	}{
		{strings.Repeat("a", linkPreviewBodyLimit+1), "text/html", 200},
		{`<title>fake</title>`, "image/svg+xml", 200},
		{`<title>not found</title>`, "text/html", 404},
	} {
		s := fixtureLinkPreviews("")
		s.client.Transport = previewRoundTripper(func(r *http.Request) (*http.Response, error) {
			return previewResponse(r, fixture.body, fixture.contentType, fixture.status), nil
		})
		if _, err := s.lookup(context.Background(), "https://example.com"); err == nil {
			t.Fatal("accepted oversized, non-HTML or failed content")
		}
	}
	s := fixtureLinkPreviews(`<title>Page</title><meta property="og:image" content="https://image.example/private.png">`)
	s.resolve = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("192.168.1.1")}}, nil
	}
	preview, err := s.lookup(context.Background(), "https://example.com")
	if err != nil || preview.Title != "Page" || preview.ImageURL != "" {
		t.Fatal("private image metadata must not reach the browser")
	}
}

func TestLinkPreviewSharesRequestsCachesFailuresAndBoundsCache(t *testing.T) {
	s := fixtureLinkPreviews("")
	var calls atomic.Int32
	entered, release := make(chan struct{}), make(chan struct{})
	s.client.Transport = previewRoundTripper(func(r *http.Request) (*http.Response, error) {
		if calls.Add(1) == 1 {
			close(entered)
		}
		<-release
		return previewResponse(r, "<title>Shared</title>", "text/html", 200), nil
	})
	var group sync.WaitGroup
	for i := 0; i < 10; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			if _, err := s.lookup(context.Background(), "https://example.com"); err != nil {
				t.Error(err)
			}
		}()
	}
	<-entered
	close(release)
	group.Wait()
	if calls.Load() != 1 {
		t.Fatal("duplicate concurrent page requests")
	}
	s.client.Transport = previewRoundTripper(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		return previewResponse(r, "", "text/html", 500), nil
	})
	for i := 0; i < 2; i++ {
		if _, err := s.lookup(context.Background(), "https://example.com/error"); err == nil {
			t.Fatal("unexpected success")
		}
	}
	if calls.Load() != 2 {
		t.Fatal("failed requests must have a short cache")
	}
	s.mu.Lock()
	s.cache["https://example.com/error"] = cachedLinkPreview{expires: time.Now().Add(-time.Second)}
	s.mu.Unlock()
	s.lookup(context.Background(), "https://example.com/error")
	if calls.Load() != 3 {
		t.Fatal("expired cache did not retry")
	}
	s.mu.Lock()
	for i := 0; i < 512; i++ {
		s.cache[fmt.Sprint(i)] = cachedLinkPreview{expires: time.Now().Add(time.Hour)}
	}
	// Replace the fixture population with exactly the maximum capacity.
	delete(s.cache, "https://example.com")
	delete(s.cache, "https://example.com/error")
	s.mu.Unlock()
	s.lookup(context.Background(), "https://example.com/another")
	if len(s.cache) != 512 {
		t.Fatalf("unbounded cache: %d", len(s.cache))
	}
}

func TestLinkPreviewCancellationAndRequestLimits(t *testing.T) {
	s := fixtureLinkPreviews("<title>Page</title>")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.lookup(ctx, "https://example.com/cancelled"); err == nil {
		t.Fatal("ignored a cancelled caller")
	}
	handler := s.Handler()
	for i := 0; i < 61; i++ {
		rec := httptest.NewRecorder()
		handler(rec, httptest.NewRequest("GET", "/api/link-preview?url="+url.QueryEscape(fmt.Sprintf("https://example.com/%d", i)), nil))
		if i < 60 && rec.Code != 200 {
			t.Fatalf("unexpected response %d", rec.Code)
		}
		if i == 60 && rec.Code != 429 {
			t.Fatal("preview miss rate limit missing")
		}
	}
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest("GET", "/api/link-preview?url=https%3A%2F%2Fexample.com%2F0", nil))
	if rec.Code != 200 {
		t.Fatal("cached previews must remain available at the request limit")
	}
	rec = httptest.NewRecorder()
	handler(rec, httptest.NewRequest("POST", "/api/link-preview", nil))
	if rec.Code != 405 {
		t.Fatal("unexpected method support")
	}
}
