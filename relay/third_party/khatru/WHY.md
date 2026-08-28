# Why khatru lives in this repo

This is khatru v0.7.6 with one patch applied:
[`../../patches/khatru-listener-race.patch`](../../patches/khatru-listener-race.patch).
`go.mod` points at this directory with a `replace`.

## The patch

`Relay.listeners` was written under `clientsMutex` by `addListener`,
`removeListenerId`, `removeClientAndListeners` and `Shutdown`, and read under
nothing by `notifyListeners` and `GetListeningFilters`. It fires whenever one
client subscribes while another publishes, which for a relay is the ordinary
case.

The removal path is the ugly one. It is a swap-delete that copies a whole
listener struct into another slot, so a concurrent reader can catch one
listener's `id` already paired with another listener's socket: an event
delivered to the wrong client, under the wrong subscription id. The same race
can also produce a nil dereference inside `WriteJSON`, and khatru has no
`recover()` anywhere, so that ends the process.

## Why a copy rather than a fork

Upstream cannot take the patch. `github.com/fiatjaf/khatru` is archived, and the
same missing lock is in every tag from v0.7.6 through v0.19.1 and on master. The
project moved to `fiatjaf.com/nostr/khatru`, which the Go module proxy cannot
resolve, so it is not usable as a dependency.

That leaves running a patched copy. A fork on GitHub and a directory here do the
same job; the directory needs no second repository to keep alive, and the patch
is visible in this repo's diffs rather than in someone else's. Since upstream is
archived there is also nothing to track: this dependency is frozen whether we
like it or not, so freezing it deliberately costs nothing.

The trade is that `git log` here now contains 2000 lines of someone else's code,
and any future khatru change means re-copying by hand. Given the upstream is
dead, that future is unlikely to arrive.

## What was removed from the copy

`docs/`, `examples/`, `.github/` and all `*_test.go`. The package imports none
of its own subpackages, so what is left is what the build needs. `LICENSE` is
kept, and khatru is MIT.

## If you touch this

The Dockerfile copies `third_party/` before `go mod download`, because the
`replace` makes the build need it at that point. Moving that `COPY` later breaks
the image build without breaking the local one, which is a bad way to find out.
