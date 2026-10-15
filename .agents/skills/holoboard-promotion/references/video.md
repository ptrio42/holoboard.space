# Holoboard promotional video guidance

## Story and visual explanation

Settle the message and keyframes before a full render when the narrative is
still being developed. An approved direction or an authorized correction is
sufficient to continue production; do not add an approval round to every edit.

Use one continuous cause-and-effect story for a short feature demo. For zap
splits, a useful sequence is: an interesting note, its arrival and rise on the
board, then one explanation of the allocation while the same note stays visible.
The viewer should understand what visibility achieves before inspecting who
receives the sats. Promote and Boost can share an explanation without becoming
two repeated journeys. Identify both actions without implying they are identical.

Explain the purposes as well as the recipients: **Visibility** for Holoboard,
**Author support** for the author. Show a single input and its two destinations.
For the short split story, show the split and its flow once. Keep per-payment
amounts distinct from the note's board total and verify the arithmetic. A sample
rank rise illustrates behavior, not a guaranteed outcome.

Use a meaningful first frame, with the hook and example content present. Each
headline should explain the action or benefit on screen. Keep a clear final
next action and a readable Holoboard URL. Move client-route detail into the
companion post when another client scene would dilute the story.

Preserve time order after payment. If native confirmation already shows the
new rank or visibility amount, return to that settled board state. Establish
the earlier state before the payment instead of replaying it after confirmation
to animate a rise. Move the settled card if useful, and reveal neighboring
headers only when they fit without overlapping or clipping their rank labels.

## Product identity and example notes

Use the current wordmark and visual sources in
[BoardLayout](../../../../web/src/components/BoardLayout/BoardLayout.tsx) and
[the stylesheet](../../../../web/src/index.css). Use the product's Press Start 2P
pixel font for short narrative headlines and labels, with readable monospace
for note bodies. Scale headings to sit comfortably beside the native interface.
Preserve the pink wordmark, cyan/pink meaning and notched geometry. Do not
substitute an invented logo or a generic oversized display font.

Keep the main composition free of extra footer subtitles, corner stage labels
and decorative lines around the allocation. Separate optional captions are
available when requested. Labels explaining visibility and author support are
part of the explanation. Check safe bounds and full note visibility after crops.

Choose content worth discovering, not filler such as "Demo creator" or a note
that merely asks a rhetorical question. A fictional person can have a natural
voice, a compact avatar and restrained emoji. Verify factual curiosities;
include a real link if the example promises a linked article or guide. A small
fictional follower count can establish context, with its illustrative nature
recorded in the delivery notes. Keep the same author, avatar, note content and
identity throughout. Do not imply that an editorial card is a new product view.

## Capture, render and review

Capture the appropriate release in an isolated preview. For simulations, use
fictional read fixtures and block external payment and event-publication calls.
Keep ranking changes and follower counts identified as illustrative in the
artifact documentation. Preparing a demo does not require real payments.

Use a shared source for example text across the opening and native captures.
Preserve previous deliverables while making new revisions. Save final copy,
composition source and a concise explanation of simulated material beside the
export. Local drafts can live under `output/promotion/`, which is ignored by Git.

Review the encoded final video, including frame zero, important transitions,
the rank rise, split flow and closing. Check a full playback and inspect actual
phone-scale frames. Verify duration, dimensions, text bounds, payment arithmetic
and the number of explanation sequences. For a 4:5 export, 360 x 450 is a useful
phone preview. Use the repository's 10px minimum for meaningful pixel labels as
a floor, and assess actual readability rather than relying only on font size.

If a contact sheet appears to lose text, inspect standalone encoded frames or
compare decoded text-region pixels before diagnosing a rendering failure.
Automated playback, decoding and pixel stability do not establish comprehension.
Report audio level checks separately from an actual listening assessment.

When comparing a reference video, inspect the reference itself and describe
specific transferable choices, such as an early premise or visual causality.
Do not attribute qualities to a reference that has not been viewed. Borrow its
communication principles while retaining Holoboard's identity.

## Explore motion and pace

When exploring a new animation direction, render short studies before committing
the whole film to it. Keep their message and example consistent so the effect
of the motion can be compared. Save both the studies and the selected combination.
A reference URL or Nostr event ID, relevant time ranges and media hash make a
later comparison reproducible; distinguish sequence inspection from playback
or listening.

Variation can come from moving words into a settled headline, travelling from
the wallet overview to one control, matching an element across shots, a stepped
reveal or a relevant cutaway. Choose the devices that explain the feature. A
larger product identifier can provide a brief accent without enlarging every
headline. Keep the opening meaningful from frame zero.

Use quick movement between actions and still holds for important reading.
Keep the recipient, amount and explicit Send action easy to inspect; do not
animate those values as decorative counters or compress review into a tap.
In the local NWC studies, the moving identifier and continuous camera were more
useful than a stepped reveal across the interface. This is an editorial finding
from that material, not a universal animation prescription.

Check encoded transition frames for clipped control borders, partial labels and
thin slivers of the next action. Where a crop would expose only a button's edge,
end the crop before that control until the complete action fits. At a settled shot, preserve native pixel labels
at the phone readability floor. An editorial crop may omit navigation, but
must preserve the payment's meaning and must not present invented controls as
the product. Sync optional sound cues to a few meaningful changes and keep
the explanation understandable when muted.

## Local zap-splits reference

If present, `output/promotion/zap-splits-v12/` contains a delivered example:
English, 23 seconds, 1080 x 1350 (4:5), no voiceover, subtle original audio,
Maya's casual GPS curiosity, a fictional small audience, an illustrative rise
from rank 4 to 2 and one 70/30 allocation. Its README, sources and verification
record the implementation. These are campaign choices, not universal settings
or evidence that this revision was approved for publication.
