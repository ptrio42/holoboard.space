# Add to board, Concept A

A standalone clickable mock of the accepted open layout. It uses the existing
Holoboard pixel font and palette, with Post, Budget and Payment stages and a
separate compact Boost example. It is not imported by the production application.

From `web`, run the existing Vite development server and open
`/prototypes/add-to-board/`. The Example selector provides a guest post, an
existing post with author support, a compact Boost and an empty editor.

Payments, wallet connections, post publication and link previews are simulated.
QR codes and copied invoice values contain only a non-payment demo identifier.
The mock makes no API, relay, signer or wallet requests. Going back preserves
prepared payment snapshots in memory, and Resume unfinished payment selects one
explicitly. Reloading or closing the page clears them. Production persistence,
cross-tab coordination, settlement, signing and recovery require the separate
[implementation plan](../../../docs/superpowers/plans/2026-10-21-add-to-board-guided-flow.md).

Review the default guest path, amount and split changes, optional appearance,
invoice access without connecting a wallet, partial payments and returning to a
prepared invoice. Choose Open in wallet, then Simulate successful payment to see
the demonstration result. Billboard appearance has one visual sample; Nostr
accounts and actual source resolution are outside this mock.
