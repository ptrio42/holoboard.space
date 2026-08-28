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

### Applying it

Upstream cannot take it: `github.com/fiatjaf/khatru` is archived, and the same
missing lock is in every tag from v0.7.6 through v0.19.1 and on master. So a
fork it is.

```bash
# fork fiatjaf/khatru, then, at tag v0.7.6:
git apply patches/khatru-listener-race.patch
git commit -am "Lock rl.listeners on the read side"
git push
```

Then in `relay/go.mod`:

```
replace github.com/fiatjaf/khatru => github.com/<account>/khatru <pseudo-version>
```

Pin the pseudo-version to the commit. A `replace` pointing at a local directory
would break the Docker build, which copies only `go.mod`, `go.sum` and `*.go`.

Afterwards, delete `relay/raceflag_race_test.go` and
`relay/raceflag_norace_test.go` and drop the `raceDetectorEnabled` skip at the
top of `startTestRelay` in `relay/nwc_test.go`. That skip exists only because of
this bug, and the point of fixing it is getting `-race` back over the payment
path.

## The other one, still open: go-nostr's client

`go-nostr` v0.34.5 `Relay.Close()` (relay.go:495-500) writes
`r.connectionContextCancel = nil` and `r.Connection = nil` with no
synchronisation, while the write loop it started reads `r.Connection`
(relay.go:196). Reproduced here on teardown, from both `NWCBackend.watchOnce`
and the test wallet's cleanup.

Failure mode is a nil dereference inside the write loop, which is a panic with
nothing to catch it. It matters because the NWC watcher closes and reopens its
connection on every reconnect.

No patch here yet. Two ways out worth weighing: a second fork, or stopping
calling `Close()` in this repo and cancelling the per-attempt context instead,
since go-nostr already tears down cleanly on `connectionContext.Done()`
(relay.go:168-178) without the racy nil writes.
