import { createAccountClient } from '@holoboard/accounts-client';

// Consume navigation secrets before starting session or configuration requests.
let token = new URL(location.href).searchParams.get('token');
history.replaceState(null, '', location.pathname);
const status = document.querySelector('#status');
const result = document.querySelector('#result');
let client;
async function run(operation) {
  if (status.dataset.busy === 'true' && client) return;
  status.dataset.busy = 'true';
  status.textContent = 'Working';
  result.textContent = '';
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  try {
    const value = await operation();
    result.textContent = JSON.stringify(value ?? null, null, 2);
    status.textContent = 'Complete';
  } catch (error) {
    // Never render raw errors, URLs, credentials or dependency diagnostics.
    status.textContent = typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'REQUEST_FAILED';
  } finally {
    for (const field of document.querySelectorAll('input[type=password]')) field.value = '';
    for (const button of document.querySelectorAll('button')) button.disabled = false;
    status.dataset.busy = 'false';
  }
}
function onSubmit(id, operation) {
  document.getElementById(id).addEventListener('submit', event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    void run(() => operation(data));
  });
}
function requireToken() { if (!token) throw { code: 'OPEN_PRIVATE_LINK_FIRST' }; return token; }
onSubmit('register', data => client.register(data));
onSubmit('resend', data => client.requestVerification(data.email));
onSubmit('verify', async () => { const value = await client.verifyEmail(requireToken()); token = null; return value; });
onSubmit('login', data => client.login(data.email, data.password));
onSubmit('session', () => client.getSession());
onSubmit('sign', data => client.signer.signEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), content: data.content, tags: [] }));
onSubmit('recovery', data => client.requestRecovery(data.email));
onSubmit('reset', async data => { await client.resetPassword(requireToken(), data.password); token = null; return { reset: true }; });
onSubmit('export', data => client.exportKey(data.password));
onSubmit('logout', async () => { token = null; await client.logout(); return { signedOut: true }; });
document.querySelector('#clear-export').addEventListener('click', () => { result.textContent = ''; });
addEventListener('pagehide', () => { token = null; result.textContent = ''; for (const field of document.querySelectorAll('input[type=password]')) field.value = ''; });
await run(async () => {
  const response = await fetch('/runtime.json', { cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw new Error();
  const config = await response.json();
  client = createAccountClient({ baseURL: config.baseURL, authBasePath: config.authBasePath });
  return client.getSession();
});
