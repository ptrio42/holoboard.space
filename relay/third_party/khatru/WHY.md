# Why khatru lives in this repo

This is khatru v0.7.6 with local patches for listener synchronization, HTTP
timeouts, NIP-11 Accept negotiation, service URL initialization and shared
client, listener, query and receive budgets. Socket frames are processed in
wire order, so CLOSE cannot overtake its REQ. See the
[patch reference](../../patches/README.md).
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

`github.com/fiatjaf/khatru` is archived. Source inspection of its final v0.19.1
still finds unlocked listener-slice reads alongside locked writes, so that
version does not remove the reason for our synchronization patch.

The project moved to `fiatjaf.com/nostr/khatru`, in the same module as the
successor to go-nostr. Earlier module-resolution failures are no longer a reason
to exclude it: on 2026-10-07, the official Go proxy resolved and downloaded
`fiatjaf.com/nostr v0.0.0-20261005012418-685c38fc6629`. Its subscription
dispatcher is rewritten, but source inspection still finds a goroutine per
incoming message. That does not establish wire-order processing or resource
budgets equivalent to the local patches. The candidate has not been integrated
or tested against Holoboard. See the [upgrade assessment](../../../docs/nostr.md#go-library-upgrade-path).

The local directory keeps the current fixes reviewable without another
repository. It is a maintained compatibility copy, not a claim that upstream
development has stopped. A migration must compare behavior, retain regression
tests and remove only patches demonstrated to be redundant.

## What was removed from the copy

`docs/`, `examples/`, `.github/` and all `*_test.go`. The package imports none
of its own subpackages, so what is left is what the build needs. `LICENSE` is
kept, and khatru is MIT.

## If you touch this

The Dockerfile copies `third_party/` before `go mod download`, because the
`replace` makes the build need it at that point. Moving that `COPY` later breaks
the image build without breaking the local one, which is a bad way to find out.
