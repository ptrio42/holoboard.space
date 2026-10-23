---
name: holoboard-promotion
description: Explain Holoboard in everyday introductions and prepare or review Nostr posts, release announcements, post series and short promotional videos. Use for ptrio42's personal posts or Holoboard-account copy, with product purpose, audience assumptions, facts and visuals grounded in this repository.
---

# Holoboard promotion

Prepare reviewable copy and media for Holoboard. Follow the checkout's agent
instructions and preserve the user's current brief and settled decisions.
Preparing content does not authorize publishing it, uploading it to an external
service, or spending sats.

## Use supporting skills

For drafting, revising or editorial review of post copy or product introductions,
read the available `copywriting` skill. This skill supplies Holoboard's context;
the supporting skill supplies reusable writing guidance.

For other parts of the brief, select the relevant supporting skills:

| Task | Supporting skill |
| --- | --- |
| Audience, campaign concept or creative direction | `creative-strategy` |
| Release narrative, previews and follow-up series | `launch-storytelling` |
| Publication calendar, topic coverage or reuse across campaigns | `content-strategy` |
| Video planning, production or assessment | `video-production`; add `video-directing` when shot composition or visual sequencing needs attention. |
| Local review-page debugging or browser screenshot checks | `webapp-testing`; reuse the repository's existing Playwright setup and capture sources. |
| Reader interviews or comprehension-test design | `product-discovery` |
| Defining campaign outcomes or analyzing collected results | `analytics` |
| Designing a controlled comparison or assessing experiment feasibility | `a-b-testing`; comparing two organic posts is not by itself a controlled experiment. |
| Generating or editing raster graphics | `imagegen` |

Resolve these names through the current available-skills catalog. Explicitly
read the selected `SKILL.md` and the task-specific references it requires;
mentioning a skill or linking a file does not load its contents. Reuse guidance
already read in the conversation when it is still current. Select for the work
being done rather than loading every skill for every post. If a helper is
unavailable, use the local guidance and disclose any meaningful limitation.

Adapt generic patterns to the user's brief, project instructions, verified
product behavior and account voice. A helper's example is not evidence of a
product claim or permission to expand the campaign. Check platform-specific
advice against the actual Nostr clients; examples from other networks do not
establish Nostr behavior or compatibility.

## Ground the message

Read the [product context](../../../docs/product.md) for Holoboard's purpose,
reader and promoter needs, the smaller-open-places motivation and short
introduction guidance. Keep current capabilities, longer-term aspirations and
audience hypotheses distinct. The initial Nostr/Bitcoin campaign audience does
not restrict the product's topics or intended audience.

For the current audience, campaign direction and weekly time budget, read the
[promotion plan](../../../docs/promotion-plan.md). Its editorial windows and
working targets are planning choices, not measured results or publication
authorization. Follow the current brief if it changes those choices.

Read the relevant sections of the [project README](../../../README.md),
[release notes](../../../CHANGELOG.md) and
[product help](../../../web/src/components/Help/HelpContent.tsx). Check
[relay documentation](../../../relay/README.md) for Nostr promotion routes.
Treat Unreleased changes as previews until deployment is confirmed. A feature
in the working tree or an old capture is not evidence of its current availability.
For a release, identify the target revision and enabled features before choosing
its highlights. The current checkout's changelog may omit changes on the release
branch; distinguish planned features from those enabled in the selected artifact.

Choose the audience benefit before selecting features to show. For discovery,
explain how a worthwhile note can receive paid visibility without its author
having a large following. Sats signal demand for visibility; they do not prove
content quality or guarantee readers, reposts or a particular rank.

## Explain Holoboard in conversation

Start with what the board offers this person and use one relevant example.
For readers, give a concrete reason to open a post. For potential promoters,
explain that paid visibility can support a recommendation of someone else's
work as well as their own promotion. Keep free reading and paid visibility clear.

Match Nostr detail to the audience. Existing Nostr users may care about using
their notes and following their conversations across clients. Other people may
first need a simple explanation of the board. Use the product context's short
introduction as a starting point and adapt it to the conversation.

Introduce a feature only when it helps the person take the suggested next step,
and check that it is available in the relevant release. Keep the builder's
personal motivation in their voice and Holoboard-account statements in the
product's voice.

## Write a Nostr post

Match the requested account. A personal builder post can explain what ptrio42
added and why; Holoboard-account copy speaks for the product. Keep the language
natural and concise. Introduce the benefit, explain the mechanism needed to
understand it, and give a clear next action. Use the length in the current brief;
roughly 50 words worked for the short zap-splits companion post, but is not a
limit for every announcement.

Let the post carry a route or qualification that would overload the video.
Keep it understandable when reposted outside the author's immediate followers.
Name specific client compatibility only after checking it. Save the exact
latest delivered copy beside its media, so file links match the conversation.
For a fresh brief, post patterns, release-series planning or review of a post
with its image, use [the production reference](references/production.md).

## Explain zap splits accurately

Check these invariants against the current implementation before reuse:

- The Holoboard share buys visibility and contributes ranking weight. Optional
  author support goes directly to the author's Lightning address and adds no
  ranking weight. Holoboard does not receive and forward the author's share.
- Promote starts or revives placement; Boost adds visibility to an existing
  campaign. Both can include author support. A website boost starts with the
  campaign allocation, which its payer can adjust for that payment.
- The first successful promotion fixes the campaign's public split and signed
  paid-promotion quote. Later payment adjustments do not rewrite that quote.
- In a Nostr client that supports splits, zap **Holoboard's paid-promotion quote
  of the original note**. Its Holoboard share boosts the original note and its
  author share supports the author. Zapping the original note is a different
  action and does not provide this board boost.
- Use "can support both" rather than claiming every boost always pays both.
  Author support is optional, requires an available address, and older campaigns
  may have no saved public split. A client without split support cannot be
  assumed to send both shares.
- Example allocations such as 70/30 are chosen demo values. Read current defaults
  from the product instead of calling the example the default. Distinguish one
  payment's visibility amount from the card's cumulative or decayed amount.
- The editors' Promote or Boost payment action prepares invoices. Wallet sends
  require a separate action; a split uses separate recipient payments that can
  settle independently.

The protocol reference for weighted recipient tags is
[NIP-57, Appendix G](https://github.com/nostr-protocol/nips/blob/master/57.md#appendix-g-zap-tag-on-other-events).
Holoboard's ranking and campaign behavior come from this repository, rather than
from NIP-57 itself.

## Explain NWC accurately

Check the current release before showing wallet features. Nostr Wallet Connect
connects a compatible Lightning wallet; it does not itself guarantee a
noncustodial wallet. Available balance, sending, receiving and history depend
on the connection's granted permissions. Read the current implementation for
each capability instead of attributing every wallet feature to the protocol.

Connecting and reviewing do not spend sats. Preserve the explicit Pay or Send
action used by the demonstrated flow and show confirmation only after its
response. Boost prepares invoices before the separate Pay action. The current local
connection lives in its browser tab; avoid implying permanent setup with
"connect once". Invoice / QR payments remain available without connecting.
An example routing fee is illustrative, not a fee guarantee.

Use the product's native password field and ephemeral fictional credentials in
captures. A local NWC mock can exercise the real SDK without a live wallet.
Block external payment and public-event writes, and verify that there are no
send requests before the explicit payment action. The protocol reference is
[NIP-47](https://github.com/nostr-protocol/nips/blob/master/47.md).

## Prepare or assess video

For a video, storyboard, reference comparison or visual review, read
[the video guidance](references/video.md). Ordinary post drafting does not need
that reference.

When asked to assess a material, inspect the actual asset before editing and
lead with a verdict and its most consequential reason. Assess attention,
causal narrative, comprehension, credibility, phone readability, brand fit and
usefulness for a repost. Separate observed defects from editorial judgment and
unmeasured audience performance. Do not claim to have watched or heard media
that was only checked through screenshots, metadata or automated playback.
