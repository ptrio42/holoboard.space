# Provenance and licenses

The original source is from Holoboard revision
`d17d09b486058d2b77c10d0339b6280f9daaf4fd`. The measured runtime graph and file hashes
are recorded in `provenance/inventory.json`. The bounded extraction retains the
original parsing, thread, media, transport and outbox assertions, with explicit
fixture bindings replacing consumer globals. The reviewed nest-rel experiment
supplies the source-partitioned cache, scoped public outbox, review/sign/save/send
flow and same-socket NIP-42 authorization state machine.

No root license grant was present in the reviewed donor source. This package is
private and marked `UNLICENSED`; this extraction does not invent a donor license
or authorize public redistribution. Its consumers remain under the maintainer's
control.

Runtime dependencies retain their own licenses. `nostr-tools` is installed as a
pinned dependency; its dependency archive retains its license files. The bundled
lightbox CSS comes from `yet-another-react-lightbox` 3.32.2 (MIT), whose license is
included in `provenance/licenses/`. Compiled utilities come from Tailwind CSS
4.1.18 (MIT), whose license is also included. The component CSS is from the
inventoried donor files. No donor font, logo, board background or other branding
asset is included or fetched.
