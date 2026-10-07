# Nostr dependency patch

Holoboard pins both the Nostr client and Khatru to the same successor module.
See [the snapshot rationale](../third_party/nostr/WHY.md) and
[architecture reference](../../docs/nostr.md).

`nostr-holoboard.patch` applies to the retained upstream files listed with
SHA-256 hashes in `../third_party/nostr/SOURCE.json`. It includes local source
changes and regression tests. It replaces the archived go-nostr and Khatru
patch series, whose original source and patches remain in Git history.

To verify provenance and reproduce the current snapshot, download the pinned
module and give the verification script its directory:

```sh
cd relay
go mod download -json fiatjaf.com/nostr@v0.0.0-20261005012418-685c38fc6629
python3 patches/verify-nostr.py /path/to/downloaded/module
```

The script verifies upstream hashes, reconstructs the retained tree in a
temporary directory, applies the patch and compares every retained file.
It does not modify the vendored copy. The source manifest deliberately omits
unused package trees and public-network tests.

After updating a revision, inspect upstream behavior before regenerating the
manifest and patch. Preserve the validation, lifetime, completeness and resource
contracts described in WHY.md. Keep deterministic protocol tests and local
regressions, then run the full application and nested-module race suites,
production build and relevant browser/payment checks. Neither `./...` in
the application nor successful compilation covers the nested module alone.
