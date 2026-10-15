# Production starting points

## Working brief

Before drafting, identify the publishing account, intended audience, one benefit,
feature availability, proof to show and next action. For video, add the format,
approximate duration, audio choice and exact wording that must be preserved.
Use the current conversation and existing delivery files to fill the brief;
ask only when a missing answer would materially change the result.

A small shot list can use these columns:

| Time or beat | Exact headline | Visible action | What the viewer should understand |
|-------------|----------------|----------------|-----------------------------------|
| Opening | The reason to care | Useful example content | Why this deserves attention |
| Change | The benefit in plain words | The same example changes visibly | What the feature makes possible |
| Explanation, if needed | A short mechanism statement | The essential control or payment flow | How the benefit works |
| Closing | A clear next action | Action and destination | What to do next |

Adapt the beats to the story. Omit an explanation that adds no understanding.
For zap splits, note discovery, board visibility and optional direct author
support belong to one continuous story. Client-routing detail fits in the post.

When promoting an enabling integration, demonstrate the product action the
brief is about. For an NWC boost film, follow a note through compact Boost,
invoice preparation, a separate explicit Pay action and the confirmed board
result. A wallet dashboard Send demonstration serves a different brief. Motion
studies can transfer between them; the narrative must match the intended use.

## Post patterns

For a personal builder post, start with a concrete motivation and connect the
feature to it. First person is appropriate when the user is speaking as its
builder. A useful draft shape is:

> {Why this matters to the reader.}
>
> I added {feature} to Holoboard. {What the reader can now do and what happens.}
> {A route or qualification needed to use it correctly.}
>
> https://holoboard.space

For the Holoboard account, lead with the user-visible change and its benefit:

> {Feature or benefit} is now available on Holoboard.
>
> {What changes for the user, with enough mechanism to make the benefit clear.}
> {Relevant compatibility or limitation.}
>
> https://holoboard.space

These are drafting aids, not mandatory wording. Keep a feature post focused.
For a release roundup, give major changes enough prominence to be understood
and use follow-up posts when a feature needs its own explanation. Do not force
the entire changelog into the short video or duplicate every visual in its post.

## Release series

Give each post a distinct job. A preview shows why an upcoming change matters;
the launch announces confirmed availability and a place to try it; a follow-up
adds a useful action, limitation or discovery that the preview did not explain.
Retelling the same example with different wording adds little to a series.

Check each post alone, as it may be reposted without the earlier entries. Keep
enough paid-visibility context for readers unfamiliar with Holoboard. Review the
next action against its actual destination: a board homepage still requires
finding a note, and a fictional demo is not a public conversation to visit.

## Review posts with images

Assess the exact copy and attached image together at phone scale, including
client headers, paragraph spacing, media placement and fixed navigation. A
successful render or lack of overflow does not establish comfortable density.
When an essential image is pushed out of view, consider removing prose that
describes what it already shows. Preserve context needed to understand the
product. Neither a fixed word limit nor fitting everything on one screen is
a universal requirement.

Choose a crop that demonstrates the promised benefit. For example, an avatar
and bio do not show whether a profile leads to another promoted note. Keep the
native flow and a complete capture available so the crop can be checked against
the real interface.

Keep the evidence behind an assessment explicit:

| Evidence | What it can establish |
| --- | --- |
| Source and feature configuration | Whether the claim matches the selected release. |
| Client captures | Layout and media behavior in the inspected clients and viewports. |
| Editorial inspection | A judgment of clarity, distinctiveness, repetition and reason to act. |
| Reader sessions or campaign results | Observed comprehension, navigation or response within the measured scope. |

Do not turn automated form checks into reader evidence or an editorial score
into measured promotional effectiveness. For repeated assessments, explain which
concrete change or new evidence warrants a different verdict. Keep the criteria
stable instead of raising the score after every rewrite.

When comparing other creators' posts, inspect the actual text and relevant
assets, save direct source links with the campaign, and name what to borrow.
Do not infer effectiveness from a well-known brand or adopt its tone wholesale.

## Reuse the existing production method

When the local example exists, inspect its `source/` and README under
`output/promotion/zap-splits-v12/` before rebuilding its tooling. Useful pieces:

| Existing piece | Reusable method | Values to replace for another film |
|----------------|-----------------|------------------------------------|
| `assets/copy.json` | Shared example text and typography settings | Note text, line breaks and brief-specific sizes |
| `source/capture-board.mjs` | Native browser captures using isolated read fixtures | Relevant release, note fixtures, selectors and states |
| `source/composition.html` | A deterministic `render(time)` canvas composition | Copy, scenes, geometry, timing and example identity |
| `source/render.mjs` | Browser frames encoded through FFmpeg | Duration, frame count, aspect ratio and story assertions |
| `source/audio.mjs` | Original generated music and transition cues | Duration, mood and cue times |
| `source/verify.mjs` and `source/review.mjs` | Decode, playback, metadata and extracted-frame review | Expected dimensions, timing, amounts and important transitions |

Use current repository dependencies for browser automation and the bundled
product font in `web/src/assets/fonts/PressStart2P-Regular.woff2`. The example
uses native Chrome and FFmpeg. Check local availability before relying on them.
If the ignored example directory is absent, recreate only the parts needed for
the requested deliverable. The skill's core message and visual guidance remain
usable without those artifacts.

Keep identity and text consistent across states. Derive frame count from the
new duration and frame rate. Adjust crops to the new content instead of keeping
the old note's geometry. Keep media checks separate from campaign-specific
assertions so a valid new story is not forced to repeat Maya, 70/30 or rank 2.

If present, `output/promotion/nwc-v1/` adds two short motion studies, a native
wallet capture through the real SDK with intercepted fictional NWC responses,
and one explicit-send story. Its sources can be reused for a wallet feature,
with new credentials generated only in memory. The demo's alias, address,
amount, balance, fee and timing are replaceable examples. Consult its capture
metadata and README rather than assuming that a composed crop is a complete
product screen.

If present, `output/promotion/nwc-boost-v2/` adds an intercepted native boost
flow through invoice preparation, NWC connection, explicit Pay, confirmation
and the settled board. Reuse its request gating and capture metadata when the
brief concerns boost payment. Its connection screen was a local unreleased
preview; check the release and source overlays before reusing the visuals.

If present, `output/promotion/next-release/` provides native product captures,
`source/capture-clients.mjs` for real hosted Nostr clients with intercepted local
read fixtures, and a separate reader-test page. Adapt the content and client
configuration, block external event and payment writes, and record the exact
copy and media checked. Browser phone emulation does not test native mobile
apps or physical devices. Keep reader-test instructions outside the material
being assessed, and distinguish automated checks from actual participant answers.
The ignored directory is optional; its captures and local servers may be stale.

## Reviewable delivery

Save the exact post copy, its media, production sources and a concise README
describing the message, simulated material and verification. For video, include
the export and agreed cover; separate captions or a silent master are optional.
Record the actual text length rather than making an example's word count a
permanent requirement. After copy or media edits, refresh affected captures and
mark any unchecked surfaces instead of presenting an older check as current.

The README and final message should identify what was visually inspected,
what playback and technical checks passed, and whether audio was listened to.
A new export is a draft unless the user has approved publication. Keep the
publishing account and any external upload within the user's authorized scope.

When the user wants to view local media in a browser, provide a simple review
page with display or playback and download, check that its localhost address works, and
include that address in delivery. A screenshot link alone is not an interactive
application preview. Distinguish local implementation from public deployment.
