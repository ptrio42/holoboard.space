package main

// short truncates s to at most n bytes. Use it instead of slicing directly
// whenever an identifier is only being abbreviated for a log line.
//
// Several identifiers reach the logging code straight from untrusted input:
// the 'e' tag of a zap request lives in the zap receipt's description tag,
// which is plain JSON that nobody signs, and event IDs pulled off remote
// relays are whatever those relays chose to send. Slicing those with a fixed
// bound panics on anything shorter, and because the payment path runs inside
// goroutines with no recover() anywhere, a single malformed event published to
// any monitored relay would take the whole process down.
func short(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
