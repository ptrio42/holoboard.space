# Why go-nostr lives in this repo

This is the Go source of `github.com/nbd-wtf/go-nostr v0.34.5`, with a local
connection-lifecycle patch. `relay/go.mod` replaces that module with this
directory. The upstream MIT license, module files and cryptographic code are
unchanged. Upstream tests, examples and non-build assets are omitted; the local
lifecycle regression tests are included.

`Relay.Close` previously cleared `Connection` while the writer read it. This
could race or panic in payment watchers and recipient profile lookups. Cancelling
the connection context alone also left the socket open. The inspected v0.38.0
implementation still clears that pointer from its cancellation worker while
the writer reads it, so it does not provide a compatible fix. Later versions
change APIs and require newer Go toolchains.

The patch keeps the connected socket reference stable, serializes connection
publication with shutdown, closes the socket on cancellation and joins the
reader, writer and subscription cleanup workers. Internal workers request
shutdown without waiting for themselves. Write results are buffered, notice
delivery can be cancelled, and pooled connections inherit the pool's lifetime.
No signing, encryption or receipt-validation behavior changes.

The complete patch is
[`go-nostr-connection-lifecycle.patch`](../../patches/go-nostr-connection-lifecycle.patch).
To refresh the dependency, compare the upstream lifecycle first, reapply the
patch if necessary and retain the regression tests. The Dockerfile already
copies `third_party` before resolving Go modules.

From `relay/`, run both application and dependency tests. Go's `./...` pattern
does not traverse this nested module:

```bash
go test -count=1 ./...
go test -count=1 -race ./...
go test -count=20 -race github.com/nbd-wtf/go-nostr
go test -count=20 -race -run 'TestAuthorSupportDiscoversProfileOutsideConfiguredRelays|TestRecipientProfile' .
```

The dependency tests use local WebSocket servers and acknowledge socket
closure. They cover concurrent writes and closes, subscriptions, parent and
pool cancellation, an unconsumed write result and an unconnected notice handler.
