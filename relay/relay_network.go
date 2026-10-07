package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"

	"fiatjaf.com/nostr"
)

const maxLookupRelays = 12

var errRelayBudget = errors.New("Nostr resource budget exhausted")

// Configuration is trusted only for the exact URL, never for event-supplied
// destinations on the same hostname. Local development must opt in explicitly.
var relayNetwork = struct {
	sync.Mutex
	trusted map[string]bool
	hosts   map[string]int
	sockets chan struct{}
	dials   chan struct{}
	lookups chan struct{}
}{trusted: map[string]bool{}, hosts: map[string]int{}, sockets: make(chan struct{}, 32), dials: make(chan struct{}, 8), lookups: make(chan struct{}, 8)}

func trustConfiguredRelays(relays []string) {
	relayNetwork.Lock()
	defer relayNetwork.Unlock()
	for _, value := range relays {
		if u, err := parseRelayURL(value); err == nil {
			relayNetwork.trusted[u.String()] = true
		}
	}
}

func parseRelayURL(value string) (*url.URL, error) {
	if len(value) > 2048 {
		return nil, fmt.Errorf("relay URL too long")
	}
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || u.Hostname() == "" || (u.Scheme != "wss" && u.Scheme != "ws") || u.User != nil || u.Fragment != "" || u.Opaque != "" {
		return nil, fmt.Errorf("invalid relay URL")
	}
	u.Host = strings.ToLower(u.Host)
	if u.Path == "/" {
		u.Path = ""
	}
	return u, nil
}

func publicRelayIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	// Include non-public special-purpose ranges not covered by IsPrivate.
	for _, value := range []string{"100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32", "2001::/32", "2002::/16", "64:ff9b::/96", "64:ff9b:1::/48", "fec0::/10", "2001:10::/28", "2001:20::/28"} {
		if netip.MustParsePrefix(value).Contains(ip) {
			return false
		}
	}
	return true
}

func relayDestination(value string) (*url.URL, bool, error) {
	u, err := parseRelayURL(value)
	if err != nil {
		return nil, false, err
	}
	relayNetwork.Lock()
	trusted := relayNetwork.trusted[u.String()]
	relayNetwork.Unlock()
	if !trusted {
		if u.Scheme != "wss" || (u.Port() != "" && u.Port() != "443") {
			return nil, false, fmt.Errorf("untrusted relays require wss on port 443")
		}
		host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
		if host == "localhost" || (!strings.Contains(host, ".") && !strings.Contains(host, ":")) || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") || strings.HasSuffix(host, ".localhost") {
			return nil, false, fmt.Errorf("local relay hints are forbidden")
		}
		if ip, err := netip.ParseAddr(host); err == nil && !publicRelayIP(ip) {
			return nil, false, fmt.Errorf("non-public relay address")
		}
	}
	return u, trusted, nil
}

func safeRelayCandidates(values []string) []string {
	result := make([]string, 0, maxLookupRelays)
	seen := map[string]bool{}
	for _, value := range values {
		u, _, err := relayDestination(value)
		if err != nil || seen[u.String()] {
			continue
		}
		seen[u.String()] = true
		result = append(result, u.String())
		if len(result) == maxLookupRelays {
			break
		}
	}
	return result
}

// All outbound Nostr sockets, including wallets and monitors, share these
// limits. DNS is resolved once and the validated IP is used by the actual dial;
// the WebSocket dialer still verifies TLS against the original hostname.
func connectRelay(ctx context.Context, value string) (*nostr.Relay, error) {
	u, trusted, err := relayDestination(value)
	if err != nil {
		return nil, err
	}
	select {
	case relayNetwork.sockets <- struct{}{}:
	default:
		return nil, errRelayBudget
	}
	relayNetwork.Lock()
	if relayNetwork.hosts[u.Host] >= 4 {
		relayNetwork.Unlock()
		<-relayNetwork.sockets
		return nil, errRelayBudget
	}
	relayNetwork.hosts[u.Host]++
	relayNetwork.Unlock()
	var once sync.Once
	release := func() {
		once.Do(func() {
			relayNetwork.Lock()
			relayNetwork.hosts[u.Host]--
			if relayNetwork.hosts[u.Host] == 0 {
				delete(relayNetwork.hosts, u.Host)
			}
			relayNetwork.Unlock()
			<-relayNetwork.sockets
		})
	}
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		select {
		case relayNetwork.dials <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		defer func() { <-relayNetwork.dials }()
		return dialRelayAddress(ctx, network, address, trusted, net.DefaultResolver.LookupNetIP)
	}
	transport := &http.Transport{DialContext: dial, TLSHandshakeTimeout: 5 * time.Second, DisableKeepAlives: true}
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	relay := nostr.NewRelay(ctx, u.String())
	if err := relay.ConnectWithClient(ctx, client); err != nil {
		relay.Close()
		transport.CloseIdleConnections()
		release()
		return nil, err
	}
	context.AfterFunc(relay.Context(), func() { relay.Close(); transport.CloseIdleConnections(); release() })
	return relay, nil
}

func dialRelayAddress(ctx context.Context, network, address string, trusted bool, lookup func(context.Context, string, string) ([]netip.Addr, error)) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ips, err := lookup(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("relay hostname has no addresses")
	}
	if !trusted {
		for _, ip := range ips {
			if !publicRelayIP(ip) {
				return nil, fmt.Errorf("relay DNS resolves to a non-public address")
			}
		}
	}
	d := net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	var last error
	for _, ip := range ips {
		conn, err := d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
		last = err
	}
	return nil, last
}
