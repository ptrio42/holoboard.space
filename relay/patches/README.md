# Upstream patches

This directory holds patches applied to vendored relay dependencies.

## khatru-listener-race.patch

`khatru.Relay.listeners` is written by `addListener`, `removeListenerId`,
`removeClientAndListeners` and `Shutdown`, all holding `clientsMutex`, and read
by `notifyListeners` and `GetListeningFilters` holding nothing. It fires whenever
one client subscribes while another publishes, which on a relay is the normal
case rather than an edge one.

Three things that can come out of it, in rising order of how bad:

- A subscriber never receives an event it paid to have promoted, because the
  publishing goroutine held a stale view of the slice.
- An event delivered to one client under another client's subscription id. The
  removal path is a swap-delete: `srl.listeners[spec.index] = moved` copies a
  whole struct, and a concurrent reader can catch one listener's `id` already
  paired with another's socket.
- A nil dereference in `WriteJSON`. There is no `recover()` anywhere in khatru,
  so that kills the process, and `fly.toml` runs a single machine.

The patch snapshots the slice under the mutex the writers already hold, then
iterates the copy outside it, so a slow client cannot stall subscribe and
unsubscribe across the whole relay.

### Verified, not assumed

Applied to a local copy of khatru v0.7.6, pointed at with a temporary `replace`,
with the `-race` skip in `nwc_test.go` removed. Every khatru race disappeared.
The only report left was the go-nostr one below, which this patch does not
touch.

### Applied, without a fork

It is already in effect. `third_party/khatru` holds a patched copy of v0.7.6 and
`go.mod` replaces the dependency with that directory. See
[`../third_party/khatru/WHY.md`](../third_party/khatru/WHY.md) for why a
directory rather than a fork, and what the Dockerfile needed.

The patch is kept here as a standalone file so it can be re-applied if the copy
is ever refreshed, and so the change is readable without diffing 2000 lines of
vendored code.

`-race` now covers the payment path, which was the point. The
`raceflag_*_test.go` files and the skip in `startTestRelay` are gone.

## khatru-http-timeouts.patch

`Relay.Start` builds its `http.Server` with `WriteTimeout: 2 * time.Second`.
Websockets do not care, because `fasthttp/websocket` clears the connection's
deadlines when it hijacks. Every other handler does.

Minting a Lightning invoice is a round trip to a wallet over nostr, and against
Coinos that runs four to twenty seconds. The server cut the connection at two,
by which point the invoice had been created and written to storage, so the
caller got a 502 from the Fly proxy reading `connection closed before message
completed` for an invoice that existed. Retrying minted another one: the logs
for 31 August show three invoices against a single note, each answered with a
502. Users reported it as "502 when trying to get invoice".

The patch keeps `ReadHeaderTimeout` short, since guarding against a client
dribbling out headers forever is the part worth bounding tightly, and leaves the
request itself room to finish. `promoteMintTimeout` in `promote_api.go` bounds
the wallet call from the handler side, so a slow wallet produces a readable
error instead of racing the server and losing.

`TestSlowHandlerResponseSurvives` drives a real khatru server rather than
`httptest`, which never applies the timeout that caused this. Putting the two
seconds back makes it fail with `EOF`.

## go-nostr-connection-lifecycle.patch

`go-nostr` v0.34.5 `Relay.Close()` cleared the connection pointer while the
writer read it. This reproduced in NWC reconnects, test-wallet cleanup and
short-lived recipient profile lookups, and could panic the backend.

The local v0.34.5 copy retains a stable connection pointer and captures the
socket in its workers. Shutdown cancels the context, closes the socket and
waits for reader, writer and subscription cleanup. Workers use an internal
shutdown method so they do not wait for themselves. Cancelling a pool now also
closes its owned relay connections. Buffered write results and cancellable
notice delivery keep shutdown from waiting on callers that stopped reading.

The patch is applied through `go.mod`, without changes to the library's
cryptography or the existing khatru patches. See
[`../third_party/go-nostr/WHY.md`](../third_party/go-nostr/WHY.md) for provenance,
the upgrade decision and regression commands. The tests verify closure using
local socket acknowledgements, with the race detector enabled.

## khatru-nip11-accept.patch

Metadata requests with a list of accepted formats previously returned 404.
The patch recognizes `application/nostr+json` within an Accept list, including
parameters and multiple header lines. A quality of zero excludes that format.
Responses vary by Accept so caches distinguish metadata from other responses.
`TestRelayDescriptionAcceptNegotiation` checks the description and CORS headers
through the vendored relay handler. Metadata follows
[NIP-11](https://github.com/nostr-protocol/nips/blob/master/11.md).

## khatru-service-url-race.patch

Concurrent first requests read and write `Relay.ServiceURL` without
synchronization. The patch runs initialization through `sync.Once` before
dispatching any request, so handlers and WebSocket authentication see the
completed value. A URL configured before serving is preserved; otherwise the
first request still supplies the host and scheme, including forwarded headers.
The field must not be changed after serving starts.

`TestRelayServiceURLConcurrentInitialization` releases 64 concurrent requests
for direct, forwarded and explicitly configured URLs. Each handler reads the
URL, and a later request checks that a different host does not replace it.
Run the regression and full race suite from `relay/`:

```sh
go test -race -run '^TestRelayServiceURLConcurrentInitialization$' -count=100 ./...
go test -race ./...
```
