# Upstream patches

Two data races live in this relay's dependencies, not in its own code. Both were
found by running `go test -race`, both are reproducible, and neither is fixed
upstream. This directory holds what to do about the first one.

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
