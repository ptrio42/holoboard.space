package khatru

import (
	"context"
	"net/http"

	"fiatjaf.com/nostr"
)

const (
	wsKey = iota
	httpRequestKey
	subscriptionIdKey
	nip86HeaderAuthKey
	internalCallKey
	serviceURLOverrideKey
)

// RequestAuth sends a NIP-42 auth request to the WebSocket connection stored in ctx.
// Only works in WebSocket context; panics if no WebSocket is in context.
func RequestAuth(ctx context.Context) {
	ws := GetConnection(ctx)
	ws.WriteJSON(nostr.AuthEnvelope{Challenge: &ws.Challenge})
}

// GetConnection returns the WebSocket stored in the context.
// Returns nil if called from a non-WebSocket context (e.g. NIP-86 HTTP handler).
func GetConnection(ctx context.Context) *WebSocket {
	wsi := ctx.Value(wsKey)
	if wsi != nil {
		return wsi.(*WebSocket)
	}
	return nil
}

// GetAuthed returns the last pubkey to have authenticated. Returns false if no one has.
//
// In a NIP-86 context it returns the single pubkey that have authenticated for that specific method call.
func GetAuthed(ctx context.Context) (nostr.PubKey, bool) {
	if conn := GetConnection(ctx); conn != nil {
		total := len(conn.AuthedPublicKeys)
		if total == 0 {
			return nostr.ZeroPK, false
		}
		return conn.AuthedPublicKeys[total-1], true
	}
	if nip86Auth := ctx.Value(nip86HeaderAuthKey); nip86Auth != nil {
		return nip86Auth.(nostr.PubKey), true
	}
	return nostr.ZeroPK, false
}

// GetAllAuthed returns all authenticated public keys.
//
// In a NIP-86 context it returns the single pubkey that authenticated for that method call.
func GetAllAuthed(ctx context.Context) []nostr.PubKey {
	if conn := GetConnection(ctx); conn != nil {
		return conn.AuthedPublicKeys
	}
	if nip86Auth := ctx.Value(nip86HeaderAuthKey); nip86Auth != nil {
		return []nostr.PubKey{nip86Auth.(nostr.PubKey)}
	}
	return []nostr.PubKey{}
}

// IsAuthed checks if the given public key is among the multiple that may have potentially authenticated.
func IsAuthed(ctx context.Context, pubkey nostr.PubKey) bool {
	if conn := GetConnection(ctx); conn != nil {
		for _, pk := range conn.AuthedPublicKeys {
			if pk == pubkey {
				return true
			}
		}
	}

	if nip86Auth := ctx.Value(nip86HeaderAuthKey); nip86Auth != nil {
		return nip86Auth.(nostr.PubKey) == pubkey
	}

	return false
}

// GetRequest returns the *http.Request stored in the context.
// Works in both WebSocket and NIP-86 contexts.
// In WebSocket context it returns conn.Request; in NIP-86 context it returns the raw HTTP request.
func GetRequest(ctx context.Context) *http.Request {
	if conn := GetConnection(ctx); conn != nil {
		return conn.Request
	}
	r := ctx.Value(httpRequestKey)
	if r != nil {
		return r.(*http.Request)
	}
	return nil
}

// ForceSetAuthed modifies the context to insert a custom authed public key.
// It can be used in testing or other rare scenarios for making requests as if a given public key
// was authenticated when in fact it didn't perform any of the authentication rituals.
func ForceSetAuthed(ctx context.Context, pubkey nostr.PubKey) context.Context {
	return context.WithValue(ctx, nip86HeaderAuthKey, pubkey)
}

// IsInternalCall returns true when a call to QueryEvents, for example, is being made because of a deletion
// or expiration request.
func IsInternalCall(ctx context.Context) bool {
	return ctx.Value(internalCallKey) != nil
}

// GetIP returns the client IP address from the request stored in context.
// Works in both WebSocket and NIP-86 contexts via GetRequest.
func GetIP(ctx context.Context) string {
	r := GetRequest(ctx)
	if r == nil {
		return ""
	}

	return GetIPFromRequest(r)
}

// GetSubscriptionID returns the subscription ID stored in the context.
// Only meaningful during filter processing (REQ message handling).
func GetSubscriptionID(ctx context.Context) string {
	return ctx.Value(subscriptionIdKey).(string)
}

// SendNotice sends a NOTICE message to the WebSocket connection stored in ctx.
// Only works in WebSocket context; panics if no WebSocket is in context.
func SendNotice(ctx context.Context, msg string) {
	GetConnection(ctx).WriteJSON(nostr.NoticeEnvelope(msg))
}
