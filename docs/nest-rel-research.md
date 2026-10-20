# Holoboard and nest-rel

The product name is `nest-rel`, lowercase with a hyphen. It replaces the
ppe-relay prototype with an independent Go core, SQLite transaction store,
operator workspace, prepaid writes, anonymous top-ups and public/private feed.
The implementation and canonical research live in the sibling `ppe-relay`
checkout, with the implementation merged into local `main`. The original directory name is
retained to preserve existing local paths and data.

Keep Holoboard campaigns, boosts, allocation, ranking and payment-session rules
in Holoboard. nest-rel provides durable event admission and billing. Its author,
authenticated publisher and payer are separate concepts. A paid exact-event
grant lets a service sponsor an existing signed note without changing that note.
Holoboard's anonymous invoice flow must remain usable without a signer or payer
wallet connection. A service identity can authorize nest-rel credit use without
requiring the paying visitor to sign in.

Public and private relay instances initially use separate processes, databases,
balances and memberships. GM content/daily limits use the shared core. Catstr
classification runs outside the database writer and must admit an event before
public storage/charging. Sundry remains a prospective private consumer; its
first experiment should be encrypted backup/restore, with record schemas, keys,
merge rules, OCR and reports owned by Sundry.

The standalone nest-rel implementation is locally verified. Holoboard's relay
has not been replaced or migrated by this work. A later integration needs a
bounded campaign adapter and compatibility checks against existing invoices,
anonymous payments and durable publication records. Deployment and migration
of existing data require separate explicit authorization.
