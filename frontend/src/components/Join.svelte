<script>
  /** Joining with an invitation (docs/PEOPLE.md): the link the owner sent,
   *  /join/<code>, opens this before anything else. It makes the account, its
   *  own folder of to-dos and a session in one go, and the app opens on it. */
  import { tick } from 'svelte';
  import * as api from '../lib/api.js';
  import { signedIn } from '../lib/store.svelte.js';
  import { beforeSignIn } from '../lib/backend.js';

  let { code, ondone } = $props();

  let invite = $state(null);        // null while asking, then { ok, note } or { error }
  let name = $state('');
  let password = $state('');
  let again = $state('');
  let error = $state(null);
  let busy = $state(false);
  let field = $state(null);

  api.checkInvite(code)
    .then((r) => {
      invite = r;
      // the owner may have written the name the invitation is for
      if (r.note && /^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,29}$/u.test(r.note)) name = r.note;
    })
    .catch((e) => (invite = { error: e.message }));

  $effect(() => { if (field) tick().then(() => field.focus()); });

  async function submit(e) {
    e.preventDefault();
    if (busy || !name.trim() || password.length < 8 || password !== again) return;
    busy = true;
    error = null;
    try {
      beforeSignIn();
      const r = await api.joinWith(code, name.trim(), password);
      password = again = '';
      history.replaceState(null, '', '/today');
      await signedIn(r && r.person);
      ondone && ondone();
    } catch (err) {
      error = err.message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="wrap">
  <form class="card" onsubmit={submit}>
    <div class="mark" aria-hidden="true">
      <svg width="44" height="44" viewBox="0 0 18 18">
        <rect width="18" height="18" rx="4" fill="var(--accent)" />
        <path d="M4.6 9.3l2.7 2.7 6.1-6.1" fill="none" stroke="#fff" stroke-width="1.9"
              stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </div>
    <h1>Join Dvarim</h1>
    {#if invite === null}
      <p class="note">Checking the invitation…</p>
    {:else if invite.error}
      <p class="err" role="alert">{invite.error}</p>
    {:else}
      <label for="join-name">Your name</label>
      <input id="join-name" type="text" bind:value={name} bind:this={field} autocomplete="username"
             autocapitalize="words" spellcheck="false" maxlength="30" disabled={busy} />
      <label for="join-pw">Password</label>
      <input id="join-pw" type="password" bind:value={password} autocomplete="new-password" disabled={busy} />
      <label for="join-again">Repeat it</label>
      <input id="join-again" type="password" bind:value={again} autocomplete="new-password" disabled={busy} />
      <p class="note">At least 8 characters. You'll sign in with your name and this password.</p>
      {#if error}<p class="err" role="alert">{error}</p>{/if}
      <button type="submit" disabled={busy || !name.trim() || password.length < 8 || password !== again}>
        {busy ? 'Joining…' : 'Join'}
      </button>
      <p class="note">Your to-dos are kept on this server, as files of your own.</p>
    {/if}
  </form>
</div>

<style>
  .wrap {
    position: fixed; inset: 0; display: grid; place-items: center;
    background: var(--page); padding: 16px; overflow-y: auto;
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
  .note { margin: 2px 0 0; font-size: 12px; color: var(--text2); line-height: 1.45; }
  .err { margin: 2px 0 0; font-size: 12.5px; color: var(--dead); }
</style>
