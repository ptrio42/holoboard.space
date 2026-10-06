package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/html"
	"golang.org/x/sync/singleflight"
)

const linkPreviewBodyLimit = 1 << 20

type linkPreview struct {
	URL         string `json:"url"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	ImageURL    string `json:"image_url,omitempty"`
}
type cachedLinkPreview struct {
	preview linkPreview
	err     error
	expires time.Time
}
type previewResolver func(context.Context, string) ([]net.IPAddr, error)
type linkPreviews struct {
	client   *http.Client
	resolve  previewResolver
	mu       sync.Mutex
	cache    map[string]cachedLinkPreview
	requests singleflight.Group
	limiter  *rateLimiter
	slots    chan struct{}
}

func newLinkPreviews() *linkPreviews {
	s := &linkPreviews{resolve: net.DefaultResolver.LookupIPAddr, cache: make(map[string]cachedLinkPreview), limiter: newRateLimiter(60, time.Minute), slots: make(chan struct{}, 8)}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := publicPreviewAddresses(ctx, host, s.resolve)
		if err != nil {
			return nil, err
		}
		// Dial the validated address directly; a second DNS lookup could rebind it.
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
	}
	s.client = &http.Client{Transport: transport, Timeout: 5 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 3 {
			return fmt.Errorf("too many preview redirects")
		}
		_, err := publicPreviewURL(req.URL.String())
		return err
	}}
	return s
}

var previewBlockedNetworks = func() []netip.Prefix {
	values := []string{"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "2001::/23", "2001:db8::/32", "2002::/16"}
	result := make([]netip.Prefix, 0, len(values))
	for _, value := range values {
		result = append(result, netip.MustParsePrefix(value))
	}
	return result
}()

func publicPreviewIP(ip net.IP) bool {
	address, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	address = address.Unmap()
	if !address.IsGlobalUnicast() || address.IsPrivate() {
		return false
	}
	if address.Is6() && !netip.MustParsePrefix("2000::/3").Contains(address) {
		return false
	}
	for _, prefix := range previewBlockedNetworks {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}

func publicPreviewURL(value string) (*url.URL, error) {
	if len(value) > 4096 {
		return nil, fmt.Errorf("preview URL is too long")
	}
	u, err := url.Parse(value)
	if err != nil || u.Hostname() == "" || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Opaque != "" {
		return nil, fmt.Errorf("use a public HTTP or HTTPS URL without credentials")
	}
	if port := u.Port(); port != "" && !(u.Scheme == "https" && port == "443") && !(u.Scheme == "http" && port == "80") {
		return nil, fmt.Errorf("preview port is not allowed")
	}
	host := strings.ToLower(u.Hostname())
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") || strings.Contains(host, "%") {
		return nil, fmt.Errorf("private preview host is not allowed")
	}
	if ip := net.ParseIP(host); ip != nil && !publicPreviewIP(ip) {
		return nil, fmt.Errorf("private preview address is not allowed")
	}
	u.Fragment = ""
	return u, nil
}

func publicPreviewAddresses(ctx context.Context, host string, resolve previewResolver) ([]net.IP, error) {
	ips, err := resolve(ctx, host)
	if err != nil || len(ips) == 0 {
		return nil, fmt.Errorf("could not resolve preview host")
	}
	result := make([]net.IP, 0, len(ips))
	for _, ip := range ips {
		if !publicPreviewIP(ip.IP) {
			return nil, fmt.Errorf("preview host resolves to a private address")
		}
		result = append(result, ip.IP)
	}
	return result, nil
}

func boundedPreviewText(value string, max int) string {
	runes := []rune(strings.Join(strings.Fields(value), " "))
	if len(runes) > max {
		runes = runes[:max]
	}
	return string(runes)
}

func parseLinkPreview(body []byte, base *url.URL) (linkPreview, error) {
	result := linkPreview{URL: base.String()}
	metadata := make(map[string]string)
	var title strings.Builder
	inTitle := false
	tokens := html.NewTokenizer(bytes.NewReader(body))
	for {
		switch tokens.Next() {
		case html.ErrorToken:
			if tokens.Err() != io.EOF {
				return result, fmt.Errorf("invalid preview document")
			}
			goto parsed
		case html.StartTagToken, html.SelfClosingTagToken:
			token := tokens.Token()
			if token.Data == "title" {
				inTitle = true
			}
			if token.Data != "meta" {
				continue
			}
			var name, content string
			for _, attr := range token.Attr {
				if attr.Key == "property" || attr.Key == "name" {
					name = strings.ToLower(attr.Val)
				}
				if attr.Key == "content" {
					content = attr.Val
				}
			}
			if _, exists := metadata[name]; !exists {
				metadata[name] = content
			}
		case html.EndTagToken:
			token := tokens.Token()
			if token.Data == "title" {
				inTitle = false
			}
			if token.Data == "head" {
				goto parsed
			}
		case html.TextToken:
			if inTitle && title.Len() < 4096 {
				title.Write(tokens.Text())
			}
		}
	}
parsed:
	result.Title = boundedPreviewText(metadata["og:title"], 240)
	if result.Title == "" {
		result.Title = boundedPreviewText(title.String(), 240)
	}
	result.Description = boundedPreviewText(metadata["og:description"], 600)
	if result.Description == "" {
		result.Description = boundedPreviewText(metadata["description"], 600)
	}
	if image, err := url.Parse(metadata["og:image"]); err == nil && metadata["og:image"] != "" {
		if safe, err := publicPreviewURL(base.ResolveReference(image).String()); err == nil {
			result.ImageURL = safe.String()
		}
	}
	if result.Title == "" && result.Description == "" && result.ImageURL == "" {
		return result, fmt.Errorf("no page metadata available")
	}
	if result.Title == "" {
		result.Title = base.Hostname()
	}
	return result, nil
}

func (s *linkPreviews) fetch(ctx context.Context, value string) (linkPreview, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, value, nil)
	if err != nil {
		return linkPreview{}, err
	}
	request.Header.Set("User-Agent", "Holoboard-LinkPreview/1.0")
	request.Header.Set("Accept", "text/html, application/xhtml+xml")
	response, err := s.client.Do(request)
	if err != nil {
		return linkPreview{}, fmt.Errorf("page preview unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return linkPreview{}, fmt.Errorf("page preview unavailable")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, linkPreviewBodyLimit+1))
	if err != nil || len(body) > linkPreviewBodyLimit {
		return linkPreview{}, fmt.Errorf("preview document is too large or incomplete")
	}
	contentType := response.Header.Get("Content-Type")
	if contentType == "" {
		contentType = http.DetectContentType(body)
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil || (mediaType != "text/html" && mediaType != "application/xhtml+xml") {
		return linkPreview{}, fmt.Errorf("preview content is not HTML")
	}
	result, err := parseLinkPreview(body, response.Request.URL)
	if err == nil && result.ImageURL != "" {
		image, _ := url.Parse(result.ImageURL)
		if _, imageErr := publicPreviewAddresses(ctx, image.Hostname(), s.resolve); imageErr != nil {
			result.ImageURL = ""
		}
	}
	return result, err
}

func (s *linkPreviews) cached(value string) (cachedLinkPreview, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.cache[value]
	return entry, ok && entry.expires.After(time.Now())
}

func (s *linkPreviews) lookup(ctx context.Context, value string) (linkPreview, error) {
	if entry, ok := s.cached(value); ok {
		return entry.preview, entry.err
	}
	result := s.requests.DoChan(value, func() (any, error) {
		if entry, ok := s.cached(value); ok {
			return entry.preview, entry.err
		}
		select {
		case s.slots <- struct{}{}:
		default:
			return linkPreview{}, fmt.Errorf("preview capacity reached")
		}
		defer func() { <-s.slots }()
		fetchContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		preview, err := s.fetch(fetchContext, value)
		ttl := time.Hour
		if err != nil {
			ttl = time.Minute
		}
		s.mu.Lock()
		if len(s.cache) >= 512 {
			for key, entry := range s.cache {
				if !entry.expires.After(time.Now()) {
					delete(s.cache, key)
				}
			}
			if len(s.cache) >= 512 {
				for key := range s.cache {
					delete(s.cache, key)
					break
				}
			}
		}
		s.cache[value] = cachedLinkPreview{preview, err, time.Now().Add(ttl)}
		s.mu.Unlock()
		return preview, err
	})
	select {
	case <-ctx.Done():
		return linkPreview{}, ctx.Err()
	case value := <-result:
		if value.Err != nil {
			return linkPreview{}, value.Err
		}
		return value.Val.(linkPreview), nil
	}
}

func (s *linkPreviews) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			writeError(w, http.StatusMethodNotAllowed, "use GET")
			return
		}
		u, err := publicPreviewURL(r.URL.Query().Get("url"))
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if _, cached := s.cached(u.String()); !cached && !s.limiter.allow(clientAddress(r), time.Now()) {
			writeError(w, http.StatusTooManyRequests, "too many link previews requested")
			return
		}
		preview, err := s.lookup(r.Context(), u.String())
		if err != nil {
			writeError(w, http.StatusBadGateway, "page preview unavailable")
			return
		}
		writeJSON(w, http.StatusOK, preview)
	}
}
