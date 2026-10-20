import type { ReviewItem, ReviewSnapshot } from './review-backend.ts';

const esc = (value: string | number): string => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const hidden = (name: string, value: string | number): string => `<input type="hidden" name="${name}" value="${esc(value)}">`;
export const REVIEW_STYLE = `
@font-face{font-family:pixel;src:url('/assets/pixel.woff2') format('woff2');font-display:swap}
:root{color-scheme:dark;background:#05010d;color:#cffafe;font:16px/1.6 ui-monospace,SFMono-Regular,monospace}
*{box-sizing:border-box}body{margin:0}main{max-width:880px;margin:auto;padding:24px 16px 64px}
header{display:flex;align-items:center;gap:16px;margin-bottom:24px}header img{width:44px;height:44px}h1{font:16px/1.8 pixel,monospace}h2{font:12px/1.8 pixel,monospace}
a{color:#67e8f9;text-underline-offset:4px}a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #ec4899;outline-offset:4px}
section,article{background:#0a0518;border:1px solid #22556a;padding:20px;margin:20px 0;overflow-wrap:anywhere}
button{min-height:44px;max-width:100%;padding:12px 16px;border:1px solid #22d3ee;background:#102638;color:#cffafe;font:10px/1.8 pixel,monospace;cursor:pointer;clip-path:polygon(0 4px,4px 4px,4px 0,calc(100% - 4px) 0,calc(100% - 4px) 4px,100% 4px,100% calc(100% - 4px),calc(100% - 4px) calc(100% - 4px),calc(100% - 4px) 100%,4px 100%,4px calc(100% - 4px),0 calc(100% - 4px))}
button.approve{background:#174134;border-color:#6ee7b7;color:#d1fae5}button.quiet{background:transparent;border-color:#597080;color:#c5d3df}
button:disabled{opacity:.45;cursor:default}.amount{color:#fbbf24;font-size:20px;font-weight:bold;white-space:nowrap}
.meta,.help{font-size:12px;color:#a5b7ca}.status{border-color:#ec4899}.actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:20px}.actions form{margin:0}
label{display:flex;align-items:flex-start;gap:12px;margin:16px 0;font-size:14px}input[type=checkbox]{width:20px;height:20px;flex-shrink:0}blockquote{margin:20px 0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:16px;color:#f1f5f9}
.note-header{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}.summary{color:#6ee7b7}.error{color:#fda4af}nav{display:flex;gap:20px;flex-wrap:wrap}
summary{min-height:44px;padding:12px 0;cursor:pointer;font:10px/1.8 pixel,monospace}
@media(max-width:360px){section,article{padding:14px}h1{font-size:12px}}
`;

function card(item: ReviewItem, csrf: string, active: boolean): string {
  const binding = hidden('csrf', csrf) + hidden('note_id', item.note_id) + hidden('review_id', item.review_id);
  const preview = item.dry_run;
  const approveDisabled = !preview && !active;
  return `<article class="review-item" data-note-id="${item.note_id}">
    <div class="note-header"><span class="amount">${esc(item.reward_sats)} sats</span><span class="meta">${preview ? 'Dry-run proposal' : item.published ? 'Already on the board; reward awaiting review' : 'Awaiting placement and reward approval'}</span></div>
    <p class="meta">Author ${esc(item.event.pubkey.slice(0, 12))}...${esc(item.event.pubkey.slice(-8))} · ${esc(item.topic)} · ${esc(item.language)}</p>
    <blockquote>${esc(item.event.content)}</blockquote>
    <p>${esc(item.reason)}</p><p class="meta">Review before ${esc(item.expires_at)}</p>
    <div class="actions"><a href="https://njump.me/${item.note_id}" target="_blank" rel="noopener noreferrer">Read original</a>
    <form action="/actions" method="post">${binding}${hidden('action', 'approve')}${hidden('reward_sats', item.reward_sats)}<button class="approve" ${approveDisabled ? 'disabled' : ''}>${preview ? 'Accept preview' : 'Approve'} · ${esc(item.reward_sats)} sats</button></form>
    <form action="/actions" method="post">${binding}${hidden('action', 'reject')}<button class="quiet">Reject</button></form></div>
    ${preview ? '<p class="help">Accepting a dry-run proposal records your review. Placement and payment remain disabled.</p>' : approveDisabled ? '<p class="help">The fund is paused or expired. You can reject this item; approval requires an active fund.</p>' : '<p class="help">Approval authorizes the proposed reward. The backend queues the payment within the fund limits.</p>'}
  </article>`;
}

export function reviewPage(snapshot: ReviewSnapshot, csrf: string, notice = ''): string {
  const messages: Record<string, string> = {
    approved: 'Approved. Placement and reward processing follow the fund rules.',
    preview_approved: 'Preview accepted. This review did not place a post or send a payment.',
    rejected: 'Rejected. No new reward will be sent for this item.',
    review_on: 'Review is on. New selections require your approval.',
    review_off: 'Review is off for future selections. Existing queued proposals still require a decision.',
  };
  const toggle = snapshot.review_required
    ? `<details><summary>Change review mode</summary>${hidden('review_required', 'false')}<label><input type="checkbox" name="confirm_auto" value="yes" required>I understand that future selections may be placed and paid automatically within the fund limits.</label><button class="quiet">Turn review off</button><p class="help">Turning review on also blocks unapproved payments that have not started. Payments already started continue to be checked.</p></details>`
    : `${hidden('review_required', 'true')}<button>Turn review on</button>`;
  const next = snapshot.offset + snapshot.items.length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Discovery review | Holoboard</title><link rel="stylesheet" href="/style.css"></head><body><main>
  <header><a href="/" aria-label="Holoboard discovery review"><img src="/assets/mark.svg" alt=""></a><h1>Discovery review</h1></header>
  <p>Review selected posts and proposed rewards.</p><p class="help">Open the original to inspect images and linked material.</p>
  ${messages[notice] ? `<section class="status" role="status">${messages[notice]}</section>` : ''}
  <section aria-label="Review settings"><h2>Review ${snapshot.review_required ? 'ON' : 'OFF'}</h2>
  <p class="help">${snapshot.review_required ? 'Approval is required before placement and payment.' : 'Future selections can be placed and rewarded automatically. The waiting queue remains unchanged.'}</p>
  <p class="meta">Fund: ${esc(snapshot.mode)} · Up to ${esc(snapshot.daily_discoveries)} discoveries and ${esc(snapshot.daily_reward_sats)} sats in rewards per day. Routing fees are additional.</p>
  <form action="/actions" method="post">${hidden('csrf', csrf)}${hidden('action', 'set_review')}${toggle}</form>
  </section>
  <h2>${snapshot.pending_count} awaiting review</h2>
  ${snapshot.items.length ? snapshot.items.map(item => card(item, csrf, snapshot.mode === 'active' && snapshot.spending_allowed)).join('') : '<section role="status">No posts await review. New proposals appear after a completed agent evaluation.</section>'}
  <nav>${snapshot.offset ? `<a href="/?offset=${Math.max(0, snapshot.offset - 21)}">Previous</a>` : ''}${next < snapshot.pending_count ? `<a href="/?offset=${next}">Next</a>` : ''}<a href="/">Refresh queue</a></nav>
  </main></body></html>`;
}

export function reviewError(message: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Review unavailable</title><link rel="stylesheet" href="/style.css"><main><h1>Review unavailable</h1><p role="alert">${esc(message)}</p><a href="/">Return to review</a></main></html>`;
}
