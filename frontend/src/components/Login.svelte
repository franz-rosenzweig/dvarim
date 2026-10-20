<script>
  /** Sign-in screen. Shown whenever the server says we are not signed in, which
   *  includes a session expiring mid-use, so no state is lost behind it. */
  import { tick } from 'svelte';
  import * as api from '../lib/api.js';
  import { signedIn } from '../lib/store.svelte.js';
  import { beforeSignIn } from '../lib/backend.js';

  // Who signed in here last (store.svelte.js, settlePerson): their name is
  // filled in and the password has the focus, which for the owner, who signs
  // in with no name, is the screen as it always was.
  let remembered = null;
  try { remembered = localStorage.getItem('dvarim.signin-name'); } catch { /* nothing remembered */ }
  let name = $state(remembered || '');
  let password = $state('');
  let error = $state(null);
  let busy = $state(false);
  let nameField = $state(null), pwField = $state(null);

  $effect(() => {
    const f = remembered !== null ? pwField : nameField;
    if (f) tick().then(() => f.focus());
  });

  // Asking for an account (docs/PEOPLE.md), where the server takes requests:
  // a name, an email and a line, for its owner to answer.
  let mode = $state('sign-in');           // 'sign-in' | 'ask' | 'asked'
  let canAsk = $state(false);
  let ask = $state({ name: '', email: '', message: '', website: '' });
  let askField = $state(null);
  api.canAsk().then((r) => (canAsk = !!(r && r.open))).catch(() => {});
  $effect(() => { if (mode === 'ask' && askField) tick().then(() => askField.focus()); });

  async function sendAsk(e) {
    e.preventDefault();
    if (busy || !ask.name.trim() || !ask.email.trim()) return;
    busy = true;
    error = null;
    try {
      await api.askForAccount(ask);
      mode = 'asked';
    } catch (err) {
      error = err.message;
    } finally {
      busy = false;
    }
  }
  const back = () => { mode = 'sign-in'; error = null; };

  async function submit(e) {
    e.preventDefault();
    if (!password || busy) return;
    busy = true;
    error = null;
    try {
      beforeSignIn();
      const r = await api.login(password, name);
      password = '';
      await signedIn(r && r.person);
    } catch (err) {
      error = err.message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="wrap">
  {#if mode === 'sign-in'}
  <form class="card" onsubmit={submit}>
    <div class="mark" aria-hidden="true">
      <svg width="44" height="44" viewBox="0 0 18 18">
        <rect width="18" height="18" rx="4" fill="var(--accent)" />
        <path d="M4.6 9.3l2.7 2.7 6.1-6.1" fill="none" stroke="#fff" stroke-width="1.9"
              stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </div>
    <h1>Dvarim</h1>
    <label for="who">Name</label>
    <input id="who" type="text" bind:value={name} bind:this={nameField} autocomplete="username"
           autocapitalize="words" spellcheck="false" disabled={busy} />
    <label for="pw">Password</label>
    <input id="pw" type="password" bind:value={password} bind:this={pwField}
           autocomplete="current-password" disabled={busy} />
    {#if error}<p class="err" role="alert">{error}</p>{/if}
    <button type="submit" disabled={busy || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
    {#if canAsk}
      <button type="button" class="link" onclick={() => { mode = 'ask'; error = null; }}>No account? Ask for one</button>
    {/if}
  </form>
  {:else if mode === 'ask'}
  <form class="card" onsubmit={sendAsk}>
    <h1>Ask for an account</h1>
    <label for="ask-name">Your name</label>
    <input id="ask-name" type="text" bind:value={ask.name} bind:this={askField} autocomplete="name" maxlength="60" disabled={busy} />
    <label for="ask-email">Email</label>
    <input id="ask-email" type="email" bind:value={ask.email} autocomplete="email" maxlength="254" disabled={busy} />
    <label for="ask-note">Anything to add</label>
    <textarea id="ask-note" rows="3" bind:value={ask.message} maxlength="500" disabled={busy}></textarea>
    <!-- for bots only: people never see it, so whatever fills it is not a person -->
    <input class="trap" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" bind:value={ask.website} />
    {#if error}<p class="err" role="alert">{error}</p>{/if}
    <button type="submit" disabled={busy || !ask.name.trim() || !ask.email.trim()}>{busy ? 'Sending…' : 'Send'}</button>
    <button type="button" class="link" onclick={back}>Back to sign in</button>
  </form>
  {:else}
  <div class="card" role="status">
    <h1>Thanks</h1>
    <p class="done">You'll hear back by email.</p>
    <button type="button" class="link" onclick={back}>Back to sign in</button>
  </div>
  {/if}
</div>

<style>
  .wrap {
    position: fixed; inset: 0; display: grid; place-items: center;
    background: var(--page); padding: 16px;
  }
  .card {
    width: min(340px, 100%);
    display: flex; flex-direction: column; gap: 8px;
    background: var(--card); color: var(--text);
    border-radius: 12px; box-shadow: var(--shadow);
    padding: 28px 24px 24px;
  }
  .mark { display: grid; place-items: center; margin-bottom: 2px; }
  h1 { margin: 0 0 10px; font-size: 19px; font-weight: 600; text-align: center; }
  label { font-size: 12px; color: var(--text2); }
  input {
    font: inherit; font-size: 15px; color: var(--text); background: var(--main);
    border: 1px solid var(--hair); border-radius: 8px; padding: 8px 10px;
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button {
    margin-top: 10px; font: inherit; font-size: 14px; font-weight: 500;
    color: #fff; background: var(--accent); border: 0; border-radius: 8px;
    padding: 9px 12px; cursor: pointer;
  }
  button:disabled { opacity: .5; cursor: default; }
  .err { margin: 2px 0 0; font-size: 12.5px; color: var(--dead); }
  textarea {
    font: inherit; font-size: 15px; color: var(--text); background: var(--main); resize: vertical;
    border: 1px solid var(--hair); border-radius: 8px; padding: 8px 10px;
  }
  textarea:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button.link { margin-top: 4px; color: var(--accent); background: none; font-weight: 400; font-size: 13px; padding: 4px; }
  .trap { position: absolute; left: -10000px; width: 1px; height: 1px; opacity: 0; }
  .done { margin: 0 0 6px; text-align: center; font-size: 14px; color: var(--text2); }
</style>
