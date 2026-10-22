import qrcode from 'qrcode-generator';

// This standalone mock never imports application services or creates invoices.
const sample = 'A community meetup this Saturday. Details: https://example.com/story';
const source = 'A small public space for sharing projects, ideas and community events. What are you building?';
const $ = (selector) => document.querySelector(selector);
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const sats = (value) => Number(value).toLocaleString('en-US');
const records = [];
let sequence = 0;
let panel = null;
let panelTrigger = null;
let panelHistory = [];
let state;

function reset(scenario) {
  state = {
    scenario, step: scenario === 'boost' ? 1 : 0,
    text: scenario === 'blank' ? '' : scenario === 'guest' ? sample : source,
    amount: 210, custom: false, mode: 'amount', author: scenario === 'existing' || scenario === 'boost' ? 20 : 0,
    billboard: false, notifications: false, method: 'invoice', connected: false,
    payment: null, recipient: 0,
  };
  panel = null;
  panelHistory = [];
  $('#editor').hidden = false;
  $('#closed').hidden = true;
  render();
}

function guest() { return state.scenario === 'guest' || state.scenario === 'blank'; }
function valid() { return Number.isInteger(Number(state.amount)) && Number(state.amount) >= 1 && Number(state.amount) <= 10_000_000 && state.amount !== ''; }
function amounts() {
  const amount = valid() ? Number(state.amount) : 0;
  const author = Math.floor(amount * state.author / 100);
  return { amount, author, board: amount - author, fee: state.billboard ? 100 : 0, total: amount + (state.billboard ? 100 : 0) };
}
function announce(message) { $('#announcement').textContent = message; }
function go(step) { panel = null; panelHistory = []; state.step = step; render(true); }
function openPanel(name, trigger) { panelHistory.push({ panel, panelTrigger }); panelTrigger = trigger; panel = name; render(true); }
function closePanel() {
  const trigger = panelTrigger;
  const previous = panelHistory.pop();
  panel = previous?.panel ?? null;
  panelTrigger = previous?.panelTrigger ?? null;
  render();
  if (trigger) $(`[data-action="${trigger}"]`)?.focus();
}
function heading(text) { return `<h2 id="stage-title" tabindex="-1">${text}</h2>`; }
function summary(payment = null) {
  const text = payment?.text ?? state.text;
  const isGuest = payment?.guest ?? guest();
  return `<div class="summary"><div class="row"><div class="identity"><span class="avatar" aria-hidden="true">${isGuest ? 'G' : 'm'}</span><strong>${isGuest ? 'Guest post' : 'maker · Original post'}</strong></div>${state.step < 2 && state.scenario !== 'boost' ? '<button class="quiet" data-action="edit">Edit post</button>' : ''}</div><p class="summary-text">${escape(text)}</p></div>`;
}
function unfinished(currentOnly = false) {
  const open = records.filter((record) => record.parts.some((part) => !part.paid) && (!currentOnly || record.id === state.payment?.id));
  if (!open.length) return '';
  return `<div class="tight">${open.map((record) => `<button class="resume" data-action="resume" data-id="${record.id}"><strong>Resume unfinished payment</strong>${sats(record.total)} sats · ${record.parts.some((part) => part.paid) ? 'Partly paid' : 'Awaiting payment'}<span class="summary-text">${escape(record.text)}</span></button>`).join('')}</div>`;
}
function postBody() {
  return `<div class="stack">${unfinished()}<section>${heading('What would you like to share?')}<p class="helper">Write a post, paste a link, or use an existing Nostr post.</p><label class="sr-only" for="post-text">Your post or link</label><textarea id="post-text" class="post-input" placeholder="Write something or paste a link…" ${guest() ? '' : 'readonly'}>${escape(state.text)}</textarea><div id="link-preview"></div>${guest() ? '<p class="helper" style="margin-top:8px">Links stay part of your post.</p>' : '<p class="helper" style="margin-top:8px">This original post stays unchanged.</p>'}</section><div class="row wrap-phone"><div class="identity"><span class="avatar" aria-hidden="true">${guest() ? 'G' : 'm'}</span><div><strong>${guest() ? 'Posting as a guest' : 'maker · Existing Nostr post'}</strong><small>${guest() ? 'No account needed' : 'Support the original author'}</small></div></div><button class="quiet" data-action="account">${guest() ? 'Use a Nostr account' : 'About this post'}</button></div><p class="notice">${guest() ? 'Your post will be public after the visibility payment. You pay with Lightning.' : 'You can give this post visibility without signing in. Paying does not change its original text.'}</p></div>`;
}
function budgetBody() {
  const a = amounts();
  const presets = state.mode === 'amount' ? [21, 210, 2100, 21000] : [84, 420, 2100, 21000];
  return `<div class="stack">${unfinished(true)}${summary()}<section>${heading(state.scenario === 'boost' ? 'Give this post more visibility' : 'How much would you like to spend?')}<div class="mode" style="margin-top:12px"><button data-action="mode-amount" aria-pressed="${state.mode === 'amount'}">Amount</button><button data-action="mode-position" aria-pressed="${state.mode === 'position'}">Position</button></div><div class="presets">${presets.map((amount, index) => `<button data-action="preset" data-amount="${amount}" aria-pressed="${!state.custom && Number(state.amount) === amount}">${state.mode === 'amount' ? sats(amount) : ['#21', '#3', '#2', '#1'][index]}</button>`).join('')}<button data-action="custom" aria-pressed="${state.custom}">Custom</button></div><div class="amount-display">${state.custom ? `<label class="sr-only" for="custom-amount">Custom amount in sats</label><input id="custom-amount" inputmode="numeric" type="text" value="${escape(state.amount)}" autocomplete="off" aria-describedby="amount-help">` : `<strong>${sats(a.amount)}</strong>`}<span class="gold">sats</span></div><p id="amount-help" class="helper" style="text-align:center">${state.mode === 'position' ? 'Sample estimates. Position can change.' : 'Paid visibility. Ranking weight fades over time.'}</p>${guest() ? '<p class="helper" style="text-align:center;margin-top:12px">100% to Holoboard for visibility.</p>' : `<div class="allocation"><div class="allocation-labels"><div class="cyan"><span>Holoboard · <span id="board-percent" style="display:inline">${100 - state.author}</span>%</span><strong id="board-amount">${sats(a.board)} sats</strong></div><div class="pink"><span>Author support · <span id="author-percent" style="display:inline">${state.author}</span>%</span><strong id="author-amount">${sats(a.author)} sats</strong></div></div><label class="sr-only" for="split">Author share</label><input id="split" type="range" min="0" max="99" value="${state.author}" style="--visibility:${100 - state.author}%" aria-valuetext="${state.author}% author support"><div class="row"><span class="helper">Author support adds no ranking weight.</span><button class="quiet" data-action="reset-split">Reset split</button></div></div>`}</section>${state.scenario === 'boost' ? '' : `<div><button class="option-row" data-action="appearance" aria-label="Billboard appearance"><span>Billboard</span><span>${state.billboard ? '+100 sats · On' : 'Optional · +100 sats'} ›</span></button><button class="option-row" data-action="options"><span>Payment options</span><span>${state.notifications ? 'Notification on' : 'Optional'} ›</span></button></div>`}</div>`;
}
function currentPart() { return state.payment.parts[state.recipient]; }
function paymentBody() {
  const p = state.payment;
  const part = currentPart();
  const partialMessage = p.parts.some((item) => item.paid) && p.parts.some((item) => !item.paid)
    ? `<p class="payment-message">Partly paid. ${p.parts[0].paid ? 'Visibility is paid. Author support remains.' : 'Author support is paid. Visibility payment remains.'}</p>` : '';
  return `<div class="stack">${summary(p)}<section><div class="row"><h2 id="stage-title" tabindex="-1">Pay with Lightning</h2><div class="payment-total"><strong>${sats(p.total)}</strong> sats</div></div>${p.fee ? '<p class="helper">Includes 100 sats for Billboard appearance.</p>' : ''}<div class="methods" style="margin-top:16px"><button data-action="invoice" aria-pressed="${state.method === 'invoice'}">Invoice / QR</button><button data-action="wallet" aria-pressed="${state.method === 'wallet'}">Wallet</button></div><div class="recipient">${p.parts.length === 1 ? `<span>Holoboard · ${sats(part.amount)} sats</span><span class="${part.paid ? 'cyan' : 'muted'}">${part.paid ? 'Paid' : 'Awaiting payment'}</span>` : p.parts.map((item, index) => `<button data-action="recipient" data-index="${index}" aria-pressed="${index === state.recipient}"><span>${item.name}</span><small>${sats(item.amount)} sats${item.paid ? ' · Paid' : ''}</small></button>`).join('')}</div>${partialMessage}<div id="payment-method">${part.paid ? '<p class="notice" style="margin-top:24px">This part is paid. Choose the remaining recipient to finish.</p>' : state.method === 'invoice' ? `<div class="qr-wrap"><div class="qr" id="qr" role="img" aria-label="Demo invoice QR code. Cannot be paid."></div><span class="eyebrow">Preview only</span></div><div class="invoice-actions"><button class="secondary" data-action="open-wallet">Open in wallet</button><button class="secondary" data-action="copy">Copy invoice</button></div><p id="copy-result" class="invoice-label" role="status"></p>` : `<div class="tight" style="margin-top:24px"><p>${state.connected ? 'Demo wallet connected' : 'Use a connected Lightning wallet.'}</p><p class="helper">Connecting a wallet does not send a payment. You will choose when to pay.</p><button class="secondary" data-action="${state.connected ? 'send' : 'connect'}">${state.connected ? `Pay ${sats(part.amount)} sats` : 'Connect wallet'}</button></div>`}</div></section></div>`;
}
function panelBody() {
  if (panel === 'appearance') return `<div class="stack">${heading('Billboard appearance')}<p>Make this post stand out on the board.</p><label class="check-row"><input type="checkbox" id="billboard" ${state.billboard ? 'checked' : ''}><span><strong>Use Billboard appearance</strong><small>+100 sats. Added to the total, without ranking weight.</small></span></label><div class="appearance-preview">${escape(state.text)}</div><p class="helper">Pink highlight preview. The original post stays unchanged. The full editor will offer appearance choices.</p></div>`;
  if (panel === 'options') return `<div class="stack">${heading('Payment options')}<section><h3>Notifications</h3>${guest() ? '<p style="margin-top:12px">Guest posts have no account to receive a confirmation DM.</p><p class="helper" style="margin-top:10px">The payment result will appear here. An account is optional.</p>' : `<label class="check-row"><input type="checkbox" id="notifications" ${state.notifications ? 'checked' : ''}><span><strong>Send me a confirmation DM</strong><small>Requires a Nostr account in the full editor. Demo selection only.</small></span></label>`}</section><p class="helper">Wallet connection is available in the Payment step. Invoice / QR always works without it.</p></div>`;
  if (panel === 'account') return `<div class="stack">${heading(guest() ? 'An account is optional' : 'Original post')}<p>${guest() ? 'Continue as a guest to publish with a Lightning payment. A Nostr account lets you use a public identity and receive confirmation messages.' : 'This sample belongs to maker. You can fund its visibility and choose how much to support the author.'}</p><p class="helper">This mock does not connect a signer or create an account.</p></div>`;
  if (panel === 'help') return `<div class="stack help-copy">${heading('How it works')}<p><span class="gold">Sats</span> are small units of bitcoin. Payments use Lightning.</p><p>Holoboard's share pays for visibility. Ranking weight fades over time. Paying does not guarantee readers or a fixed position.</p><p>Support for a post's author is separate from visibility. A split can mean two invoices, one for each recipient.</p><p>A guest post becomes public after its visibility payment. Public posts may remain on the wider Nostr network even after leaving the board.</p><p>Going back keeps prepared invoices unchanged. Return to them with Resume unfinished payment.</p><p class="helper">Prototype limit: payments are simulated and kept only while this page stays open. The planned production flow will recover unfinished payments in the same browser after reopening it.</p></div>`;
  if (panel === 'demo-wallet') return `<div class="stack">${heading('Demo wallet')}<p class="notice">This is a payment simulation. No wallet will open and no funds will be sent.</p><div class="row"><span>${currentPart().name}</span><strong class="gold">${sats(currentPart().amount)} sats</strong></div><button class="secondary" data-action="simulate">Simulate successful payment</button><p class="helper">Use this to inspect the next screen. It does not test Lightning settlement.</p></div>`;
  return '';
}
function resultBody() {
  const p = state.payment;
  return `<div class="stack"><div><div class="result-icon" aria-hidden="true">✓</div>${heading('Added to the board')}<p style="margin-top:12px">${p.guest ? 'Your guest post is now public.' : 'This post has more paid visibility.'}</p></div>${summary(p)}<ul class="result-list">${p.parts.map((part) => `<li class="row"><span>${part.name} <span class="cyan">✓ Paid</span></span><span class="gold">${sats(part.amount)} sats</span></li>`).join('')}<li class="row"><strong>Total</strong><strong class="gold">${sats(p.total)} sats</strong></li></ul><p class="helper">Demo result. No post was published and no payment was made.</p></div>`;
}
function render(focus = false) {
  const boost = state.scenario === 'boost';
  $('#editor').classList.toggle('compact', boost);
  $('#editor').classList.toggle('split-payment', state.step === 2 && state.payment.parts.length > 1);
  $('#editor').dataset.stage = ['post', 'budget', 'payment', 'result'][state.step];
  $('#editor-title').textContent = boost ? 'Boost' : 'Add to board';
  $('#progress').hidden = boost || state.step === 3;
  $('#progress').innerHTML = `<ol class="steps">${['Post', 'Budget', 'Payment'].map((name, index) => `<li class="${index < state.step ? 'complete' : ''}" ${index === state.step ? 'aria-current="step"' : ''}><span class="step-dot" aria-hidden="true"></span>${index < state.step ? `<button data-action="step" data-step="${index}">${name}</button>` : `<span>${name}</span>`}</li>`).join('')}</ol>`;
  $('#body').innerHTML = panel ? panelBody() : state.step === 0 ? postBody() : state.step === 1 ? budgetBody() : state.step === 2 ? paymentBody() : resultBody();
  renderFooter();
  if (!panel && state.step === 0) updateLink();
  if (!panel && state.step === 2 && state.method === 'invoice' && !currentPart().paid) {
    const qr = qrcode(0, 'M');
    qr.addData(`holoboard-demo:${state.payment.id}:${state.recipient}:${currentPart().amount}`);
    qr.make();
    $('#qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
  }
  if (focus) {
    $('#body').scrollTop = 0;
    $('#stage-title')?.focus({ preventScroll: true });
  }
}
function renderFooter() {
  const a = amounts();
  let primary = '';
  let note = '';
  let back = '';
  if (panel) {
    if (state.step === 1 && (panel === 'appearance' || panel === 'options')) {
      primary = `<button class="primary" data-action="continue" ${valid() ? '' : 'disabled'}>Continue to payment · ${sats(a.total)} sats</button>`;
      note = 'Creates invoices. No payment sent yet.';
    }
    back = '<button data-action="panel-back">‹ Back</button>';
  } else if (state.step === 0) {
    primary = `<button class="primary" data-action="continue" ${state.text.trim() ? '' : 'disabled'}>Review &amp; continue</button>`;
  } else if (state.step === 1) {
    primary = `<button class="primary" data-action="continue" ${valid() ? '' : 'disabled'}>${state.payment ? 'Prepare new payment' : 'Continue to payment'} · ${sats(a.total)} sats</button>`;
    note = valid() ? 'Creates invoices. No payment sent yet.' : 'Enter a whole amount from 1 to 10,000,000 sats.';
    if (state.scenario !== 'boost') back = '<button data-action="back">‹ Back to post</button>';
  } else if (state.step === 2) {
    back = '<button data-action="back">‹ Back to budget</button>';
    note = 'Going back keeps these invoices.';
  } else {
    primary = '<button class="primary" data-action="done">Done</button>';
  }
  $('#footer').innerHTML = `${primary}${note ? `<p class="footer-note">${note}</p>` : ''}<div class="footer-links">${back || '<span></span>'}${panel === 'help' ? '' : '<button data-action="help">Help</button>'}</div>`;
}
function updateLink() {
  const link = state.text.match(/https?:\/\/[^\s<>]+/i)?.[0];
  let url;
  try { url = link ? new URL(link) : null; } catch { url = null; }
  $('#link-preview').innerHTML = url ? `<div class="link-preview"><div class="link-icon" aria-hidden="true">↗</div><div><p class="cyan">${escape(url.hostname)}</p><p class="muted">${escape(url.pathname === '/' ? 'Link preview' : url.pathname)}</p></div></div>` : '';
}
function prepare() {
  if (!valid()) return;
  const a = amounts();
  const record = {
    id: ++sequence, text: state.text, guest: guest(), total: a.total, fee: a.fee,
    draft: { ...state, payment: null },
    parts: [{ name: 'Holoboard', amount: a.board + a.fee, paid: false }],
  };
  if (a.author) record.parts.push({ name: 'Author', amount: a.author, paid: false });
  records.push(record);
  state.payment = record;
  state.recipient = 0;
  go(2);
}
function pay() {
  const paidName = currentPart().name;
  currentPart().paid = true;
  const next = state.payment.parts.findIndex((part) => !part.paid);
  panel = null;
  if (next === -1) go(3);
  else { state.recipient = next; render(true); announce(`${paidName} paid. ${currentPart().name} payment remains.`); }
}
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === 'continue') { if (state.step === 0) go(1); else prepare(); }
  else if (action === 'back') go(state.step - 1);
  else if (action === 'edit') go(0);
  else if (action === 'step') go(Number(button.dataset.step));
  else if (action === 'preset') { state.amount = Number(button.dataset.amount); state.custom = false; render(); $(`[data-action="preset"][data-amount="${state.amount}"]`)?.focus(); }
  else if (action.startsWith('mode-')) { state.mode = action.slice(5); render(); $(`[data-action="${action}"]`).focus(); }
  else if (action === 'custom') { state.custom = true; render(); $('#custom-amount').focus(); $('#custom-amount').select(); }
  else if (action === 'reset-split') { state.author = 20; render(); $('[data-action="reset-split"]').focus(); }
  else if (['appearance', 'options', 'help', 'account'].includes(action)) openPanel(action, action);
  else if (action === 'panel-back') closePanel();
  else if (action === 'invoice' || action === 'wallet') { state.method = action; render(); $(`[data-action="${action}"]`).focus(); }
  else if (action === 'recipient') { state.recipient = Number(button.dataset.index); render(); $(`[data-action="recipient"][data-index="${state.recipient}"]`).focus(); }
  else if (action === 'open-wallet' || action === 'send') openPanel('demo-wallet', action);
  else if (action === 'connect') { state.connected = true; render(); $('[data-action="send"]').focus(); announce('Demo wallet connected. No payment sent.'); }
  else if (action === 'simulate') pay();
  else if (action === 'copy') {
    const payload = `holoboard-demo:${state.payment.id}:${state.recipient}:${currentPart().amount}`;
    try { await navigator.clipboard.writeText(payload); $('#copy-result').textContent = 'Demo invoice copied. It cannot be paid.'; }
    catch { $('#copy-result').textContent = `Copy this demo value: ${payload}`; }
  }
  else if (action === 'resume') {
    const record = records.find((item) => item.id === Number(button.dataset.id));
    state = { ...record.draft, payment: record, recipient: record.parts.findIndex((part) => !part.paid), method: 'invoice' };
    $('#scenario').value = state.scenario;
    go(2);
  }
  else if (action === 'close' || action === 'done') { $('#editor').hidden = true; $('#closed').hidden = false; $('[data-action="reopen"]').focus(); }
  else if (action === 'reopen') { $('#editor').hidden = false; $('#closed').hidden = true; render(true); }
});
document.addEventListener('input', (event) => {
  const input = event.target;
  if (input.id === 'post-text') { state.text = input.value; updateLink(); renderFooter(); }
  else if (input.id === 'custom-amount') {
    state.amount = /^\d+$/.test(input.value) ? Number(input.value) : '';
    input.setAttribute('aria-invalid', String(!valid()));
    if (!guest()) {
      const a = amounts();
      $('#author-amount').textContent = `${sats(a.author)} sats`;
      $('#board-amount').textContent = `${sats(a.board)} sats`;
    }
    renderFooter();
  }
  else if (input.id === 'split') {
    state.author = Number(input.value);
    const a = amounts();
    $('#author-percent').textContent = state.author;
    $('#board-percent').textContent = 100 - state.author;
    $('#author-amount').textContent = `${sats(a.author)} sats`;
    $('#board-amount').textContent = `${sats(a.board)} sats`;
    input.style.setProperty('--visibility', `${100 - state.author}%`);
    input.setAttribute('aria-valuetext', `${state.author}% author support`);
  }
});
document.addEventListener('focusin', (event) => { if (event.target.id === 'custom-amount') event.target.select(); });
document.addEventListener('change', (event) => {
  const input = event.target;
  if (input.id === 'scenario') reset(input.value);
  else if (input.id === 'billboard') { state.billboard = input.checked; renderFooter(); }
  else if (input.id === 'notifications') state.notifications = input.checked;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && panel) { event.preventDefault(); closePanel(); }
});
reset('guest');
