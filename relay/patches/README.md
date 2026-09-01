# Upstream patches

This directory holds changes that belong to dependencies rather than to this
relay's own code: two data races found by running `go test -race`, and one
hardcoded timeout that made the payment endpoint unusable in production. All
three are reproducible and none is fixed upstream.

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

## The other one, still open: go-nostr's client

`go-nostr` v0.34.5 `Relay.Close()` (relay.go:495-500) writes
`r.connectionContextCancel = nil` and `r.Connection = nil` with no
synchronisation, while the write loop it started reads `r.Connection`
(relay.go:196). Reproduced here on teardown, from both `NWCBackend.watchOnce`
and the test wallet's cleanup.

Failure mode is a nil dereference inside the write loop, which is a panic with
nothing to catch it. It matters because the NWC watcher closes and reopens its
connection on every reconnect.

No fix here yet, and one obvious idea does not work. Cancelling the per-attempt
context instead of calling `Close()` looks appealing, because the cleanup
goroutine at relay.go:167-179 runs on `connectionContext.Done()` without any of
the racy nil writes. But that goroutine closes the notices channel, stops the
ticker and unsubscribes, and never touches `r.Connection`. Only `Close()` closes
the socket. Swapping one for the other trades a race for a connection leak on
every reconnect, which is worse.

What is left: the same in-tree copy treatment, or an upgrade. Unlike khatru,
go-nostr is not archived, so checking whether a later release synchronises
`Close()` is the first thing to try, bearing in mind the in-tree khatru requires
go-nostr v0.34.x and would need adjusting alongside.
