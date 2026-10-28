<script>
  /** Settings sheet: a row of panes across the top, a form below. Server-backed
   *  values go to PUT /api/settings; the ones that are about this browser
   *  (appearance, text size) stay in localStorage. */
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import Keyboard from './Keyboard.svelte';
  import * as api from '../lib/api.js';
  import { IN_ANDROID_SHELL, IN_MAC_SHELL, IN_WINDOWS_SHELL, SHELL_KEEPS_COPY, askShell } from '../lib/shell.js';
  import { where, switchTo, pickFolder, checkVault, showDeviceCalendars } from '../lib/backend.js';
  import { syncConfig, configure, syncNow as davSyncNow, watchSync, davUrl } from '../lib/davsync.js';
  import { app, closeSettings, saveSettings, getTheme, setTheme, getTextScale, setTextScale, toast, toastError, signOut, confirm, showTutorial } from '../lib/store.svelte.js';

  const PANES = [
    { id: 'general',  label: 'General',  icon: 'sliders' },
    { id: 'calendar', label: 'Calendar', icon: 'cal' },
    { id: 'keyboard', label: 'Keyboard', icon: 'keyboard' },
    { id: 'quickadd', label: 'Quick Add', icon: 'plus' },
    { id: 'account',  label: 'Account',  icon: 'person' },
    { id: 'sync',     label: 'Sync',     icon: 'repeat' },
    { id: 'data',     label: 'Data',     icon: 'files' },
  ];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  let pane = $state('general');
  let theme = $state(getTheme());
  let scale = $state(getTextScale());
  let cal = $state(null);          // {configured, calendars} | {error}
  let sync = $state(null);
  let syncBusy = $state(false), syncMsg = $state(null);
  let el = $state(null);
  let s = $derived(app.settings || {});
  const vault = where();
  // the server's page, with or without a copy of its vault on this device (lib/backend.js)
  const onServer = vault.kind === 'server' || vault.kind === 'mirror';
  let checking = $state(false), checked = $state(null);    // the storage contract's checks, run on this folder
  let merges = $state(null);                                  // what merging has done here (local mode)

  $effect(() => {
    if (pane === 'data' && vault.kind !== 'server' && merges === null) {
      api.getSync().then((r) => (merges = r.log || [])).catch(() => (merges = []));
    }
  });

  /** "3 min ago", "yesterday" — for the list of merges. */
  function ago(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ms).toLocaleDateString();
  }

  async function checkFolder() {
    checking = true;
    checked = null;
    try {
      checked = await checkVault();
    } catch (e) {
      checked = { ok: false, results: [{ name: 'running the checks', ok: false, error: e && e.message ? e.message : String(e) }] };
    } finally {
      checking = false;
    }
  }

  $effect(() => { if (el) tick().then(() => el.focus()); });
  $effect(() => {
    if (pane === 'calendar' && cal === null) {
      // Wrapped so a throw here cannot leave the pane stuck on "Looking for
      // calendars…" with nothing said. It did exactly that once.
      Promise.resolve()
        .then(() => api.getCalendars())
        .then((r) => (cal = r))
        .catch((e) => (cal = { configured: false, calendars: [], error: e.message }));
      Promise.resolve()
        .then(() => api.getTaskSync())
        .then((r) => (sync = r))
        .catch((e) => (sync = { enabled: false, error: e.message }));
    }
  });

  function set(key, value) { saveSettings({ [key]: value }); }

  /** Turn this device's own calendars on or off; asking again for the list
   *  is what brings up the system's permission prompt, the first time. */
  function deviceCalendars(on) {
    showDeviceCalendars(on);
    cal = null;
  }

  // null means every calendar; a list means exactly those. Keeping those
  // distinct is what lets you untick the last one and actually see nothing.
  let eventCalendars = $derived(
    (cal && cal.calendars ? cal.calendars : []).filter((c) => c.components.includes('VEVENT'))
  );
  const shown = (name) => !s.calendars || s.calendars.includes(name);
  function toggleCalendar(name, on) {
    const all = eventCalendars.map((c) => c.name);
    const current = s.calendars ? s.calendars.filter((n) => all.includes(n)) : all;
    const next = on
      ? [...new Set([...current, name])]
      : current.filter((n) => n !== name);
    set('calendars', next.length === all.length ? null : next);
  }

  async function syncNow() {
    syncBusy = true; syncMsg = null;
    try {
      const r = await api.runTaskSync();
      const moved = ['pushed', 'pulled', 'adopted', 'buried', 'pruned']
        .filter((k) => r[k]).map((k) => `${r[k]} ${k}`);
      syncMsg = moved.length ? moved.join(', ') + '.' : 'Already up to date.';
      sync = await api.getTaskSync();
    } catch (e) {
      syncMsg = e.message;
    } finally {
      syncBusy = false;
    }
  }
  function onkeydown(e) { if (e.key === 'Escape') { e.stopPropagation(); closeSettings(); } }

  const origin = typeof location !== 'undefined' ? location.origin : '';
  let copied = $state('');
  let curPw = $state(''), newPw = $state(''), againPw = $state('');
  let pwBusy = $state(false), pwMsg = $state(null), pwErr = $state(false);

  async function changePw() {
    if (pwBusy) return;
    pwBusy = true; pwMsg = null; pwErr = false;
    try {
      await api.changePassword(curPw, newPw);
      curPw = newPw = againPw = '';
      pwMsg = 'Changed. Your other devices have been signed out.';
    } catch (e) {
      pwMsg = e.message; pwErr = true;
    } finally {
      pwBusy = false;
    }
  }
  // ---- Account, for the owner: who else keeps their to-dos on this server (docs/PEOPLE.md)
  let household = $state(null);          // GET /api/people, or {error}
  let ownerName = $state(''), inviteNote = $state(''), newInvite = $state(null), peopleBusy = $state(false);
  let resetFor = $state(null), resetPw = $state('');
  const isOwner = $derived(!!(app.person && app.person.owner));
  const day = (t) => new Date(t * 1000).toLocaleDateString();
  $effect(() => {
    if (pane === 'account' && onServer && app.authRequired && isOwner && household === null) loadPeople();
  });
  async function loadPeople() {
    try {
      household = await api.getPeople();
      ownerName = household.owner.name || '';
    } catch (e) {
      household = { error: e.message };
    }
  }
  async function saveOwnerName() {
    try {
      const me = await api.setOwnerName(ownerName.trim());
      app.person = me;
      toast('Saved');
    } catch (e) {
      toastError(e);
    }
  }
  async function makeInvite() {
    if (peopleBusy) return;
    peopleBusy = true;
    try {
      newInvite = await api.invitePerson(inviteNote.trim());
      inviteNote = '';
      await loadPeople();
    } catch (e) {
      toastError(e);
    } finally {
      peopleBusy = false;
    }
  }
  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(newInvite.link);
      toast('Link copied');
    } catch {
      toast('Select the link and copy it');
    }
  }
  async function shareInvite() {
    try { await navigator.share({ title: 'Dvarim', url: newInvite.link }); } catch { /* closed without sharing */ }
  }
  async function cancelInvite(id) {
    try {
      await api.cancelInvite(id);
      if (newInvite && newInvite.id === id) newInvite = null;
      await loadPeople();
    } catch (e) {
      toastError(e);
    }
  }
  async function removePerson(p) {
    try {
      await api.removePerson(p.name);
      toast(`${p.display} removed. Their to-dos are kept on the server.`);
      await loadPeople();
    } catch (e) {
      toastError(e);
    }
  }
  // someone who asked for an account from the sign-in page: an invitation in
  // their name, and the email to send it in, ready in the mail app
  async function inviteFromRequest(r) {
    try {
      newInvite = await api.inviteRequest(r.id);
      await loadPeople();
    } catch (e) {
      toastError(e);
    }
  }
  async function dismissRequest(r) {
    try {
      await api.dismissRequest(r.id);
      await loadPeople();
    } catch (e) {
      toastError(e);
    }
  }
  function mailto(inv) {
    const first = String(inv.name || '').trim().split(' ')[0] || 'there';
    const me = household && household.owner && household.owner.name;
    const body = [
      `Hi ${first},`,
      '',
      "Here's the link to set up your Dvarim account. Open it whenever you're ready, pick a name and a password, and that's it. It works once, within a week.",
      '',
      inv.link,
      '',
      "Once you're in, you can add it to your phone's home screen so it opens like an app. Everything is kept on my own server, in files of your own, and Settings → Data has a button that downloads all of it whenever you like. The app keeps everyone's lists apart, though since I run the server I could technically see the files, so I'm just letting you know.",
      ...(me ? ['', me] : []),
    ].join('\n');
    return `mailto:${inv.email}?subject=${encodeURIComponent('Your Dvarim account')}&body=${encodeURIComponent(body)}`;
  }

  async function setTheirPassword() {
    try {
      await api.resetPassword(resetFor.name, resetPw);
      toast(`Done. Give ${resetFor.display} the new password.`);
      resetFor = null;
      resetPw = '';
    } catch (e) {
      toastError(e);
    }
  }

  // ---- Sync: on the server, the devices that sync with it; on a device, where it syncs to
  let devices = $state(null);                       // [{name, created}] | {error}
  let devName = $state(''), newDevice = $state(null), devBusy = $state(false);
  $effect(() => {
    if (pane === 'sync' && onServer && devices === null) {
      api.getDevices().then((r) => (devices = r.tokens || [])).catch((e) => (devices = { error: e.message }));
    }
  });
  async function addDev() {
    if (devBusy) return;
    devBusy = true;
    try {
      newDevice = await api.addDevice(devName.trim());
      devName = '';
      devices = (await api.getDevices()).tokens || [];
    } catch (e) {
      toastError(e);
    } finally {
      devBusy = false;
    }
  }
  async function removeDev(name) {
    try {
      await api.removeDevice(name);
      if (newDevice && newDevice.name === name) newDevice = null;
      devices = (await api.getDevices()).tokens || [];
    } catch (e) {
      toastError(e);
    }
  }

  const saved = syncConfig() || {};
  let syncKind = $state(saved.kind || 'off');
  let syncAddress = $state(saved.address || ''), syncToken = $state(saved.token || '');
  let syncUrl = $state(saved.url || ''), syncUser = $state(saved.user || ''), syncPassword = $state(saved.password || '');
  let davStatus = $state({ state: 'off' });
  let davBusy = $state(false), davErr = $state(null);
  $effect(() => (vault.kind === 'server' ? undefined : watchSync((st) => (davStatus = st))));
  let davReady = $derived(syncKind === 'off' || (syncKind === 'dvarim' ? !!(syncAddress.trim() && syncToken.trim())
    : !!(syncUrl.trim() && syncUser.trim() && syncPassword)));
  async function saveSync() {
    if (davBusy) return;
    davBusy = true; davErr = null;
    try {
      const cfg = syncKind === 'off' ? null
        : syncKind === 'dvarim' ? { kind: 'dvarim', address: syncAddress.trim(), token: syncToken.trim() }
        : { kind: 'webdav', url: syncUrl.trim(), user: syncUser.trim(), password: syncPassword };
      await configure(cfg);
    } catch (e) {
      davErr = e && e.message ? e.message : String(e);
    } finally {
      davBusy = false;
    }
  }
  async function davSyncClick() {
    davErr = null;
    try { await davSyncNow(); } catch (e) { davErr = e && e.message ? e.message : String(e); }
  }
  /** "2 sent, 1 received" — what a round did. */
  function roundSaid(r) {
    if (!r) return '';
    const parts = [[r.sent, 'sent'], [r.taken, 'received'], [r.merged, 'merged'], [r.deleted, 'deleted']]
      .filter(([list]) => list && list.length).map(([list, w]) => `${list.length} ${w}`);
    return parts.length ? parts.join(', ') : 'nothing to do';
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); copied = text; setTimeout(() => (copied = ''), 1400); }
    catch { toastError(new Error('Your browser blocked the clipboard. Select the text and copy it.')); }
  }
</script>

<div class="scrim" role="presentation" onclick={closeSettings}></div>
<div class="sheet" role="dialog" aria-modal="true" aria-label="Settings" bind:this={el} tabindex="-1" {onkeydown}>
  <header>
    <h2>Settings</h2>
    <button class="x" onclick={closeSettings} aria-label="Close settings">Done</button>
  </header>

  <div class="panes" role="tablist">
    {#each PANES as p}
      <button role="tab" id={`pane-tab-${p.id}`} aria-selected={pane === p.id} aria-controls="pane-body"
              class:on={pane === p.id} onclick={() => (pane = p.id)}>
        <span class="ic"><Icon name={p.icon} /></span><span class="lb">{p.label}</span>
      </button>
    {/each}
  </div>

  <div class="body" id="pane-body" role="tabpanel" aria-labelledby={`pane-tab-${pane}`}>
    {#if pane === 'general'}
      <div class="grid">
        <label for="set-log">Move completed items to Logbook:</label>
        <select id="set-log" value={s.logCompleted || 'immediately'} onchange={(e) => set('logCompleted', e.currentTarget.value)}>
          <option value="immediately">Immediately</option>
          <option value="daily">Daily</option>
          <option value="manually">Manually</option>
        </select>

        <label for="set-badge">Badge count:</label>
        <select id="set-badge" value={s.badgeCount || 'today'} onchange={(e) => set('badgeCount', e.currentTarget.value)}>
          <option value="none">None</option>
          <option value="today">Today</option>
          <option value="inbox">Inbox</option>
        </select>

        <label for="set-appearance">Appearance:</label>
        <select id="set-appearance" value={theme} onchange={(e) => { theme = e.currentTarget.value; setTheme(theme); }}>
          <option value="system">Automatic</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>

        <label for="set-scale">Text size:</label>
        <div class="slider">
          <span class="a sm">A</span>
          <input id="set-scale" type="range" min="85" max="130" step="5" value={scale}
                 oninput={(e) => { scale = +e.currentTarget.value; setTextScale(scale); }} />
          <span class="a lg">A</span>
          <button class="reset" onclick={() => { scale = 100; setTextScale(100); }} disabled={scale === 100}>Default</button>
        </div>

        <label for="set-week">Week starts on:</label>
        <select id="set-week" value={String(s.weekStartsOn ?? 0)} onchange={(e) => set('weekStartsOn', +e.currentTarget.value)}>
          {#each DAYS as d, i}<option value={String(i)}>{d}</option>{/each}
        </select>

        <label for="set-evening">This Evening starts at:</label>
        <input id="set-evening" class="time" type="time" value={s.eveningStartsAt || '18:00'}
               onchange={(e) => set('eveningStartsAt', e.currentTarget.value)} />
      </div>

      <div class="checks">
        <label><input id="set-group" type="checkbox" checked={!!s.groupTodayByList}
               onchange={(e) => set('groupTodayByList', e.currentTarget.checked)} />
          Group to-dos in the Today list by project or area</label>
      </div>
      <p class="tut">
        <button class="linkish" onclick={showTutorial}>Show the tutorial again</button>
        <span class="note">the “Meet Dvarim” project, where every to-do is something to try</span>
      </p>

    {:else if pane === 'calendar'}
      <label class="one"><input id="set-cal-on" type="checkbox" checked={!!s.showCalendarEvents}
             onchange={(e) => set('showCalendarEvents', e.currentTarget.checked)} />
        Show calendar events in Today and Upcoming lists</label>
      {#if cal === null}
        <p class="note">Looking for calendars…</p>
      {:else if !cal.configured && vault.kind === 'browser'}
        <p class="note">
          A vault kept in this browser has no calendars to show. In the Mac and Android apps,
          events come from the device's own calendars.
        </p>
      {:else if !cal.configured && cal.offered}
        <p class="note">
          Today and Upcoming can show the events in this device's own calendars. The first time,
          the device asks whether Dvarim may read them.
        </p>
        <button class="primary" onclick={() => deviceCalendars(true)}>Show this device's calendars</button>
      {:else if !cal.configured && !onServer}
        <p class="note">
          This version of the app can't read the device's calendars yet.
        </p>
      {:else if !cal.configured}
        <p class="note">
          No calendar server configured. Set <code>DVARIM_CALDAV_URL</code>, <code>DVARIM_CALDAV_USER</code>
          and <code>DVARIM_CALDAV_PASS</code> on the container and your Radicale calendars appear here.
        </p>
      {:else if cal.error && cal.source === 'device'}
        <p class="note err">Couldn't read this device's calendars: {cal.error}</p>
        <button class="linkish" onclick={() => deviceCalendars(false)}>Stop showing this device's calendars</button>
      {:else if cal.error}
        <p class="note err">Could not reach the calendar server: {cal.error}</p>
      {:else}
        <div class="callist">
          <div class="allnone">
            <button onclick={() => set('calendars', null)}>All</button>
            <button onclick={() => set('calendars', [])}>None</button>
          </div>
          {#each eventCalendars as c}
            <label>
              <input type="checkbox" checked={shown(c.name)}
                     onchange={(e) => toggleCalendar(c.name, e.currentTarget.checked)} />
              <span class="dot" style="background:{c.color || 'var(--text3)'}"></span>{c.name}
            </label>
          {/each}
          {#if !cal.calendars.length}<p class="note">{cal.source === 'device' ? 'This device has no calendars.' : 'The server has no event calendars.'}</p>{/if}
        </div>
        {#if cal.source === 'device'}
          <button class="linkish" onclick={() => deviceCalendars(false)}>Stop showing this device's calendars</button>
        {/if}
      {/if}

      <h3>Your to-dos in other apps</h3>
      {#if !onServer}
        <p class="note">
          A Dvarim server can mirror open to-dos to a CalDAV task list, for Tasks.org, Apple
          Reminders and other apps. A vault kept on this device doesn't do that.
        </p>
      {:else if sync === null}
        <p class="note">Checking…</p>
      {:else if !sync.enabled}
        <p class="note">
          Not switched on. With a calendar server configured, set <code>DVARIM_TASKSYNC=1</code>
          and your open to-dos appear as a task list any CalDAV app can use.
        </p>
      {:else}
        <p class="note">
          Open to-dos are mirrored to a <strong>Dvarim</strong> task list on your calendar server, so
          Tasks.org on Android, Apple Reminders or any CalDAV app can show them and tick them off.
          What you do there comes back here. Completed and Someday items are not sent.
        </p>
        <p class="note">
          {#if sync.lastError}<span class="err">Last cycle failed: {sync.lastError}</span>
          {:else if sync.lastRun}Last synced {sync.lastRun}.
          {:else}Not run yet.{/if}
        </p>
        <button class="primary" onclick={syncNow} disabled={syncBusy}>
          {syncBusy ? 'Syncing…' : 'Sync now'}
        </button>
        {#if syncMsg}<p class="note">{syncMsg}</p>{/if}
      {/if}

    {:else if pane === 'keyboard'}
      <Keyboard />

    {:else if pane === 'quickadd'}
      <p class="note">
        A web app cannot take a global hotkey, so anything that can make an
        HTTP request can add to your Inbox instead — the Signal bot, a Shortcut, a bookmarklet, cron.
      </p>
      <pre class="code">curl -X POST {origin}/api/quick-add \
  -H 'content-type: application/json' \
  -d '&#123;"text": "Call the plumber tomorrow 3pm #home !fri"&#125;'</pre>
      <button class="copy" onclick={() => copy(`${origin}/api/quick-add`)}>
        {copied ? 'Copied' : 'Copy the endpoint'}
      </button>
      <p class="note">
        The text is read the way quick entry reads it: a trailing date phrase sets When
        (<code>tomorrow</code>, <code>sunday</code>, <code>in 3 days</code>, <code>oct 2</code>,
        <code>someday</code>), <code>!friday</code> sets a deadline, <code>@9am</code> a reminder,
        and <code>#tag</code> anywhere tags it. Anything it is unsure of stays in the title.
      </p>

    {:else if pane === 'account'}
      {#if app.authRequired}
        {#if app.person && (app.person.name || !app.person.owner)}
          <p class="note">Signed in as <b>{app.person.name}</b>.</p>
        {/if}
        <p class="note">
          Changing your password signs out your other devices. This one stays signed in.
        </p>
        <div class="pw">
          <label for="pw-cur">Current password</label>
          <input id="pw-cur" type="password" bind:value={curPw} autocomplete="current-password" />
          <label for="pw-new">New password</label>
          <input id="pw-new" type="password" bind:value={newPw} autocomplete="new-password" />
          <label for="pw-again">Repeat it</label>
          <input id="pw-again" type="password" bind:value={againPw} autocomplete="new-password" />
        </div>
        {#if pwMsg}<p class="note" class:err={pwErr}>{pwMsg}</p>{/if}
        <button class="primary" onclick={changePw}
                disabled={pwBusy || !curPw || newPw.length < 8 || newPw !== againPw}>
          {pwBusy ? 'Changing…' : 'Change password'}
        </button>
        <p class="note">At least 8 characters. A long phrase beats a short tangle.</p>
        <div class="signout">
          <button onclick={() => { closeSettings(); signOut(); }}>Sign out</button>
          <span class="note">Ends this browser's session only.</span>
        </div>

        {#if isOwner && onServer}
          <h3>People</h3>
          {#if household === null}
            <p class="note">Loading…</p>
          {:else if household.error}
            <p class="note err">{household.error}</p>
          {:else}
            <p class="note">
              Invite someone to keep their own to-dos on this server. Each person has a folder of their
              own, signs in with their name, and sees only their own lists.
            </p>
            {#if !household.enabled}<p class="note err">{household.reason}</p>{/if}
            <div class="adddev">
              <label for="owner-name">Your name</label>
              <input id="owner-name" type="text" bind:value={ownerName} maxlength="30" placeholder="Optional"
                     onkeydown={(e) => { if (e.key === 'Enter') saveOwnerName(); }} />
              <button class="linkish" onclick={saveOwnerName}>Save</button>
            </div>
            <p class="note">Nobody else can take it. You can sign in with it, or with no name at all.</p>
            {#if household.requests && household.requests.length}
              <ul class="devices" aria-label="Asking for an account">
                {#each household.requests as r (r.id)}
                  <li>
                    <span class="dname">{r.name}</span>
                    <span class="dwhen">{r.email} · asked {day(r.created)}</span>
                    <button class="linkish" onclick={() => inviteFromRequest(r)}>Invite</button>
                    <button class="linkish" onclick={(e) => confirm(e.currentTarget, `Dismiss ${r.name}'s request? They aren't told.`, [
                      { label: 'Dismiss', action: () => dismissRequest(r) },
                      { label: 'Cancel' },
                    ])}>Dismiss</button>
                  </li>
                  {#if r.message}<li class="asked">“{r.message}”</li>{/if}
                {/each}
              </ul>
            {/if}
            {#if household.people.length}
              <ul class="devices" aria-label="People">
                {#each household.people as p (p.name)}
                  <li>
                    <span class="dname">{p.display}</span>
                    {#if p.created}<span class="dwhen">joined {day(p.created)}</span>{/if}
                    <button class="linkish" onclick={() => { resetFor = p; resetPw = ''; }}>New password…</button>
                    <button class="linkish" onclick={(e) => confirm(e.currentTarget, `Remove ${p.display}? They're signed out at once. Their to-dos are kept in a folder on the server, not deleted.`, [
                      { label: 'Remove', action: () => removePerson(p) },
                      { label: 'Cancel' },
                    ])}>Remove</button>
                  </li>
                  {#if resetFor && resetFor.name === p.name}
                    <li class="adddev">
                      <label for="their-pw" class="vh">A new password for {p.display}</label>
                      <input id="their-pw" type="text" bind:value={resetPw} placeholder="A new password for {p.display}" autocomplete="off" spellcheck="false" />
                      <button class="primary" onclick={setTheirPassword} disabled={resetPw.length < 8}>Set it</button>
                      <button class="linkish" onclick={() => (resetFor = null)}>Cancel</button>
                    </li>
                  {/if}
                {/each}
              </ul>
            {/if}
            {#if household.invites.length}
              <ul class="devices" aria-label="Invitations">
                {#each household.invites as inv (inv.id)}
                  <li>
                    <span class="dname">Invitation{inv.note ? ` for ${inv.note}` : ''}</span>
                    <span class="dwhen">good until {day(inv.expires)}</span>
                    <button class="linkish" onclick={() => cancelInvite(inv.id)}>Cancel</button>
                  </li>
                {/each}
              </ul>
            {/if}
            {#if household.enabled}
              <div class="adddev">
                <label for="invite-note" class="vh">Who it's for</label>
                <input id="invite-note" type="text" bind:value={inviteNote} maxlength="60" placeholder="Who it's for, like Dana"
                       onkeydown={(e) => { if (e.key === 'Enter') makeInvite(); }} />
                <button class="primary" onclick={makeInvite} disabled={peopleBusy}>Make an invitation link</button>
              </div>
            {/if}
            {#if newInvite}
              <div class="newdev" data-invite-shown>
                <p class="note">Send this link. It works once, until {day(newInvite.expires)}, and is shown only now.</p>
                <code class="token">{newInvite.link}</code>
                <div class="syncacts">
                  {#if newInvite.email}<a class="mail" href={mailto(newInvite)}>Email it to {newInvite.email}</a>{/if}
                  <button class="primary" onclick={copyInvite}>Copy</button>
                  {#if typeof navigator !== 'undefined' && navigator.share}<button class="linkish" onclick={shareInvite}>Share…</button>{/if}
                </div>
              </div>
            {/if}
          {/if}
        {/if}
      {:else}
        <p class="note">
          This server has no password set, so anyone who can reach it can use it. Set one with
          <code>docker exec -it dvarim node server/src/cli.js set-password</code>.
        </p>
      {/if}

    {:else if pane === 'sync'}
      {#if onServer}
        <p class="note">
          This server is also where other devices can sync. The Mac app, the Android app, or a
          browser keeping a vault of its own can each keep a copy of these to-dos, work with no
          network, and sync here. Changes made in two places at once are merged, to-do by to-do.
          Each device gets its own token.
        </p>
        {#if !app.authRequired}
          <p class="note">This server has no password, so a device can sync with it without a token.</p>
        {/if}
        {#if devices === null}
          <p class="note">Loading…</p>
        {:else if devices.error}
          <p class="note err">{devices.error}</p>
        {:else}
          {#if devices.length}
            <ul class="devices">
              {#each devices as d (d.name)}
                <li>
                  <span class="dname">{d.name}</span>
                  {#if d.created}<span class="dwhen">added {new Date(d.created * 1000).toLocaleDateString()}</span>{/if}
                  <button class="linkish" onclick={(e) => confirm(e.currentTarget, `Remove ${d.name}? It stops syncing at once. Its copy of the to-dos stays on it.`, [
                    { label: 'Remove', action: () => removeDev(d.name) },
                    { label: 'Cancel' },
                  ])}>Remove</button>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="note">No devices yet.</p>
          {/if}
          <div class="adddev">
            <label for="dev-name" class="vh">Device name</label>
            <input id="dev-name" type="text" placeholder="A name, like Phone" bind:value={devName} maxlength="40"
                   onkeydown={(e) => { if (e.key === 'Enter' && devName.trim()) addDev(); }} />
            <button class="primary" onclick={addDev} disabled={devBusy || !devName.trim()}>Add a device</button>
          </div>
        {/if}
        {#if newDevice}
          <div class="newdev" data-token-shown>
            <p class="note">
              On <strong>{newDevice.name}</strong>, open Settings → Sync, choose <em>A Dvarim server</em>, and enter:
            </p>
            <dl class="kv">
              <dt>Address</dt>
              <dd><code>{origin}</code> <button class="copy" onclick={() => copy(origin)}>{copied === origin ? 'Copied' : 'Copy'}</button></dd>
              <dt>Token</dt>
              <dd><code class="token">{newDevice.token}</code> <button class="copy" onclick={() => copy(newDevice.token)}>{copied === newDevice.token ? 'Copied' : 'Copy'}</button></dd>
            </dl>
            <p class="note">
              The token is shown only this once. If it is lost, remove the device and add it again.
              Other WebDAV apps can use this server's folder too: <code>{origin}/dav/</code>, any user
              name, and the token as the password.
            </p>
          </div>
        {/if}
      {:else if vault.sync && vault.sync.app}
        <p class="note">
          This app keeps its own copy of your to-dos, so everything works with no network, and syncs
          it with <code>{vault.sync.address}</code> a moment after each change. The app set it up.
        </p>
        <div class="syncacts">
          <button class="linkish" onclick={davSyncClick} disabled={davStatus.state === 'syncing'}>Sync now</button>
        </div>
        <p class="note" data-sync-state={davStatus.state}>
          {#if davStatus.offline}Can't reach the server right now. Your changes are kept here until it's back.
          {:else if davErr || davStatus.state === 'error'}<span class="err">Couldn't sync: {davErr || davStatus.error}</span>
          {:else if davStatus.state === 'syncing'}Syncing…
          {:else if davStatus.at}Last synced {ago(davStatus.at)}: {roundSaid(davStatus.result)}.{/if}
        </p>
      {:else}
        <p class="note">
          Keep this device's to-dos in step with a server. Every device keeps its own copy and works
          with no network. Changes made in two places at once are merged, to-do by to-do.
        </p>
        <div class="kinds" role="radiogroup" aria-label="Sync with">
          <label><input type="radio" name="sync-kind" value="off" bind:group={syncKind} /> Off</label>
          <label><input type="radio" name="sync-kind" value="dvarim" bind:group={syncKind} /> A Dvarim server</label>
          <label><input type="radio" name="sync-kind" value="webdav" bind:group={syncKind} /> A WebDAV server: Nextcloud, Synology, and others</label>
        </div>
        {#if syncKind === 'dvarim'}
          <div class="pw">
            <label for="sync-address">Server address</label>
            <input id="sync-address" type="url" inputmode="url" placeholder="dvarim.example.com" bind:value={syncAddress} autocomplete="url" />
            <label for="sync-token">Device token</label>
            <input id="sync-token" type="password" bind:value={syncToken} autocomplete="off" />
          </div>
          <p class="note">To get a token: on the server, open Settings → Sync → Add a device.
            {#if syncAddress.trim()}This device will use <code>{davUrl(syncAddress)}</code>.{/if}</p>
        {:else if syncKind === 'webdav'}
          <div class="pw">
            <label for="sync-url">Folder address</label>
            <input id="sync-url" type="url" inputmode="url" placeholder="https://cloud.example.com/remote.php/dav/files/you/Dvarim/" bind:value={syncUrl} />
            <label for="sync-user">User name</label>
            <input id="sync-user" type="text" bind:value={syncUser} autocomplete="username" />
            <label for="sync-password">Password</label>
            <input id="sync-password" type="password" bind:value={syncPassword} autocomplete="current-password" />
          </div>
          <p class="note">
            If the server offers app passwords, use one. In a web browser, many WebDAV servers turn
            away requests from other sites, this app included. If the server can't be reached,
            sync from the Mac or Android app instead.
          </p>
        {/if}
        {#if vault.kind === 'device' && syncKind !== 'off'}
          <p class="note">Don't also let another app sync this folder (Syncthing, iCloud Drive). Use one or the other.</p>
        {/if}
        <div class="syncacts">
          <button class="primary" onclick={saveSync} disabled={davBusy || !davReady}>
            {davBusy ? 'Syncing…' : syncKind === 'off' ? 'Stop syncing' : 'Save and sync'}
          </button>
          {#if davStatus.state !== 'off'}
            <button class="linkish" onclick={davSyncClick} disabled={davStatus.state === 'syncing'}>Sync now</button>
          {/if}
        </div>
        <p class="note" data-sync-state={davStatus.state}>
          {#if davErr || davStatus.state === 'error'}<span class="err">Couldn't sync: {davErr || davStatus.error}</span>
          {:else if davStatus.state === 'syncing'}Syncing…
          {:else if davStatus.at}Last synced {ago(davStatus.at)}: {roundSaid(davStatus.result)}.
          {:else if davStatus.state === 'off'}Not syncing.{/if}
        </p>
        <p class="note">
          The password or token stays on this device. The to-dos, settings and sort orders go to the
          server.
        </p>
      {/if}

    {:else}
      <p class="note">
        Every list, project and to-do is a Markdown file. There is no database, so the app can be
        deleted and the work is still there, readable in Obsidian or any text editor.
      </p>
      <dl class="kv">
        <dt>Areas</dt><dd>{(app.state && app.state.areas.length) || 0}</dd>
        <dt>Projects</dt><dd>{((app.state && app.state.areas.reduce((n, a) => n + a.projects.length, 0)) || 0) + ((app.state && app.state.looseProjects.length) || 0)}</dd>
        <dt>Tags</dt><dd>{(app.state && app.state.tags.length) || 0}</dd>
        <dt>Today</dt><dd>{(app.state && app.state.counts.today) || 0}</dd>
      </dl>
      <p class="note">
        Sort order and these settings live in a small <code>.dvarim/state.json</code> beside the files.
        Nothing else is kept outside them.
      </p>
      {#if onServer}
        {#if IN_ANDROID_SHELL || IN_MAC_SHELL}
          <p class="note">To download them all as a .zip, open Dvarim in a browser and use Settings → Data there.</p>
        {:else}
          <p><a class="linkish" href="/api/export" download>Download my files</a> <span class="note">every note, as a .zip</span></p>
        {/if}
      {/if}

      <h3>Where these to-dos live</h3>
      {#if vault.kind === 'mirror'}
        <p class="note">
          On the server this page came from, with a full copy on this device, so every list and every
          change works with no network. The copy syncs with the server a moment after each change,
          whenever something changes there, and as soon as the server can be reached again.
        </p>
        <p class="note" data-mirror-status>
          {#if davStatus.state === 'syncing'}Syncing…
          {:else if davStatus.offline}Can't reach the server right now. Your changes are kept here until it's back.
          {:else if davStatus.state === 'error'}Couldn't sync: {davStatus.error}
          {:else if davStatus.at}Last synced {new Date(davStatus.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
          {/if}
        </p>
        <div class="vaultacts">
          <button class="linkish" onclick={() => davSyncNow().catch(() => {})} disabled={davStatus.state === 'syncing'}>Sync now</button>
          <button class="linkish" onclick={(e) => confirm(e.currentTarget, 'Use the server without a copy on this device? Lists you haven\'t opened won\'t be there offline.', [
            { label: 'Use the server only', action: () => switchTo('server') },
            { label: 'Cancel' },
          ])}>Use the server without a copy…</button>
        </div>
      {:else if vault.kind === 'server'}
        <p class="note">
          On the server this page came from, so every device that opens it sees the same files.
          Only the lists you've opened are kept here for when there's no network.
        </p>
        <button class="linkish" onclick={() => (SHELL_KEEPS_COPY ? askShell({ type: 'useCopy' }) : switchTo('mirror'))}>Keep a full copy on this device, so it all works offline</button>
        {#if !IN_ANDROID_SHELL && !IN_MAC_SHELL}
          <p class="note">
            This browser can keep a vault of its own instead: it needs no server at all, and works
            with no network. It starts empty, and the server's to-dos stay where they are.
            Experimental.
          </p>
          <button class="linkish" onclick={(e) => confirm(e.currentTarget, 'Switch this browser to a vault of its own? It starts empty; the server keeps its to-dos.', [
            { label: 'Keep a vault in this browser', action: () => switchTo('local') },
            { label: 'Cancel' },
          ])}>Keep a vault in this browser instead…</button>
        {/if}
      {:else if vault.kind === 'browser'}
        <p class="note">
          <strong>In this browser</strong>, not on a server: nothing leaves this device, and it all
          works offline. The files are the same Markdown, kept in the browser's own storage — so
          clearing this site's data would delete them.
        </p>
        <button class="linkish" onclick={() => switchTo('server')}>Go back to the server's to-dos</button>
      {:else}
        <p class="note">
          <strong>In a folder on this device</strong>{#if vault.name}: <span class="folder">{vault.name}</span>{/if}.
          The files are plain Markdown, so whatever keeps that folder in step keeps these to-dos in
          step — Syncthing, iCloud Drive, Obsidian Sync — and it all works with no network.
        </p>
        {#if vault.detail}<p class="note path" dir="ltr">{vault.detail}</p>{/if}
        <div class="vaultacts">
          {#if vault.canPick}
            <button class="linkish" onclick={() => pickFolder()}>Choose another folder…</button>
          {/if}
          {#if vault.canUseServer}
            <button class="linkish" onclick={(e) => confirm(e.currentTarget, 'Use a server instead of this folder? The folder is left as it is.', [
              { label: 'Use a server', action: () => switchTo('server') },
              { label: 'Cancel' },
            ])}>Use a server instead…</button>
          {/if}
          <button class="linkish" onclick={checkFolder} disabled={checking}>{checking ? 'Checking…' : 'Check this folder'}</button>
        </div>
        {#if merges && merges.length}
          <p class="note">
            <strong>Merged from elsewhere</strong> since the app opened: these files changed here and
            on another device at the same time, and both sets of changes were kept.
          </p>
          <ul class="merges">
            {#each merges.slice(0, 5) as m}
              <li>
                <span class="mfile">{m.path.split('/').pop().replace(/\.md$/, '')}</span>
                — {m.kind === 'merged' ? 'merged' : 'a sync conflict copy merged back and put in .dvarim/conflicts'}{m.conflicts && m.conflicts.length ? `; ${m.conflicts.length} change${m.conflicts.length === 1 ? '' : 's'} made on both sides, settled by the rules` : ''}
                <span class="mwhen">{ago(m.at)}</span>
              </li>
            {/each}
          </ul>
        {/if}
        {#if checked}
          {@const failed = checked.results.filter((r) => !r.ok)}
          {#if checked.ok}
            <p class="note checkok" data-check="ok">
              All {checked.results.length} checks passed, in {(checked.results.reduce((n, r) => n + r.ms, 0) / 1000).toFixed(1)} s.
            </p>
          {:else}
            <p class="note checkbad" data-check="failed">{failed.length} of {checked.results.length} checks failed:</p>
            <ul class="checkfails">
              {#each failed as f}<li><strong>{f.name}</strong> — {f.error}</li>{/each}
            </ul>
          {/if}
        {/if}
      {/if}

      {#if IN_ANDROID_SHELL}
        <h3>This Android app</h3>
        <p class="note">
          The app is a window on this server, so a few things belong to the window rather than to
          the server: the address it opens, whether Android lets its reminders through, and which
          build it is. They are kept out there, so that a server you cannot reach is not also a
          server you cannot change.
        </p>
        <p><a class="native" href="dvarim://settings">Open the app's own settings</a></p>
      {/if}
      {#if IN_MAC_SHELL}
        <h3>This Mac app</h3>
        <p class="note">
          The app is a window on this server, so a few things belong to the window rather than to
          the server: the address it opens, Quick Entry's shortcut, Today in the menu bar, opening at
          login, and whether reminders arrive on this Mac. They live under Dvarim → Settings….
        </p>
        <p><a class="native" href="dvarim://settings">Open the app's own settings</a></p>
      {/if}
      {#if IN_WINDOWS_SHELL}
        <h3>This Windows app</h3>
        <p class="note">
          A few things belong to the app rather than to your to-dos: where they live and which
          server it syncs with, Quick Entry's shortcut, starting with Windows, and whether reminders
          arrive on this PC. They are in the app's own settings, which Dvarim's icon in the
          notification area also opens.
        </p>
        <p><a class="native" href="dvarim://settings">Open the app's own settings</a></p>
      {/if}

    {/if}
  </div>
</div>

<style>
  .devices { list-style: none; margin: 8px 0 12px; padding: 0; }
  .devices li { display: flex; align-items: baseline; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--hair); }
  .devices .dname { font-weight: 600; }
  .devices .dwhen { color: var(--text3); font-size: .9em; flex: 1; }
  .adddev, .syncacts { display: flex; gap: 8px 16px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
  .adddev input { flex: 1; min-width: 10em; font: inherit; font-size: 13.5px; padding: 5px 8px; border: 1px solid var(--hair); border-radius: 6px; background: var(--main); color: var(--text); }
  .newdev { margin-top: 12px; }
  .newdev code.token { word-break: break-all; user-select: all; }
  .kinds { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; }
  input[type="radio"] { accent-color: var(--accent); }
  .vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .scrim { position: fixed; inset: 0; background: rgba(20, 20, 30, .28); z-index: 40; }
  :global(:root[data-theme="dark"]) .scrim { background: rgba(0, 0, 0, .5); }
  /* Anchored to a fixed top rather than centred: the panes are different
     heights, and centring made the whole window jump every time you switched
     tab. Now only the bottom edge moves. */
  .sheet {
    position: fixed; z-index: 41; left: 50%; transform: translateX(-50%);
    top: clamp(16px, 9vh, 76px);
    width: min(580px, calc(100vw - 32px));
    max-height: min(660px, calc(100vh - clamp(16px, 9vh, 76px) - 24px));
    display: flex; flex-direction: column; outline: none;
    background: var(--card); color: var(--text);
    border-radius: 12px; box-shadow: var(--shadow);
  }
  /* Fades the last row out at the bottom edge so a scrollable pane looks
     scrollable. It is card-colour to transparent, so on a pane that fits it
     is drawn over its own background and cannot be seen. */
  .sheet::after {
    content: ''; position: absolute; left: 1px; right: 1px; bottom: 1px; height: 24px;
    pointer-events: none; border-radius: 0 0 11px 11px;
    background: linear-gradient(to top, var(--card), transparent);
  }
  header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 6px; }
  h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .x { border: 0; background: none; color: var(--accent); font: inherit; font-size: 13.5px; cursor: pointer; padding: 2px 4px; border-radius: 6px; }
  /* flex: none matters. Without it the tab strip was the thing that gave way
     when a tall pane (Keyboard) filled the sheet, and the labels were clipped
     off the bottom of their own buttons. */
  .panes { flex: none; display: flex; gap: 2px; padding: 4px 10px 8px; border-bottom: 1px solid var(--hair); }
  .panes button {
    flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 5px;
    padding: 7px 4px; border: 0; background: none; color: var(--text2);
    font: inherit; font-size: 11.5px; line-height: 1.2; border-radius: 7px; cursor: pointer;
  }
  .panes .lb { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .panes button:hover { background: var(--hover); }
  .panes button.on { background: var(--sel); color: var(--text); }
  .panes button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  /* One size for all six, whatever each glyph was drawn at. */
  .panes .ic { display: grid; place-items: center; width: 18px; height: 18px; }
  .panes .ic :global(svg) { width: 16px; height: 16px; }
  .body { flex: 1 1 auto; min-height: 240px; padding: 16px 16px 24px; overflow-y: auto; }
  .grid { display: grid; grid-template-columns: auto 1fr; gap: 10px 12px; align-items: center; }
  .grid label { justify-self: end; text-align: right; color: var(--text); font-size: 13.5px; }
  select, .time {
    font: inherit; font-size: 13.5px; color: var(--text); background: var(--main);
    border: 1px solid var(--hair); border-radius: 7px; padding: 4px 8px; max-width: 220px;
  }
  .slider { display: flex; align-items: center; gap: 8px; }
  .slider input[type="range"] { flex: 1; max-width: 150px; accent-color: var(--accent); }
  .a { color: var(--text2); } .a.sm { font-size: 11px; } .a.lg { font-size: 17px; }
  .reset { font: inherit; font-size: 12px; color: var(--accent); background: none; border: 0; cursor: pointer; }
  .reset:disabled { color: var(--text3); cursor: default; }
  .checks { margin-top: 16px; display: flex; flex-direction: column; gap: 9px; }
  .checks label, .one, .callist label { display: flex; align-items: center; gap: 8px; font-size: 13.5px; }
  .one { margin-bottom: 12px; }
  input[type="checkbox"] { accent-color: var(--accent); width: 15px; height: 15px; }
  .callist { display: flex; flex-direction: column; gap: 8px; padding-left: 4px; }
  .allnone { display: flex; gap: 10px; margin: 2px 0 6px; }
  .allnone button {
    font: inherit; font-size: 12px; color: var(--accent); background: none;
    border: 0; padding: 0; cursor: pointer;
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .note { color: var(--text2); font-size: 12.5px; line-height: 1.5; margin: 10px 0; max-width: 62ch; }
  .note.err { color: var(--dead); }
  h3 { margin: 22px 0 0; font-size: 13px; font-weight: 600; padding-top: 14px; border-top: 1px solid var(--hair); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; background: var(--pill); border-radius: 4px; padding: 1px 4px; }
  .code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; line-height: 1.6;
    background: var(--hover); border: 1px solid var(--hair); border-radius: 8px;
    padding: 10px 12px; overflow-x: auto; white-space: pre; margin: 4px 0 8px;
  }
  .copy { font: inherit; font-size: 12.5px; color: var(--accent); background: none; border: 0; cursor: pointer; padding: 2px 0; }
  .native { font: inherit; font-size: 13.5px; color: var(--accent); text-decoration: none; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 12px 0; font-size: 13.5px; }
  .kv dt { color: var(--text2); justify-self: end; }
  .kv dd { margin: 0; font-variant-numeric: tabular-nums; }
  .signout { display: flex; align-items: baseline; gap: 12px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--hair); }
  .signout button { font: inherit; font-size: 13.5px; color: var(--dead); background: none; border: 0; cursor: pointer; padding: 2px 0; }
  .signout .note { margin: 0; }
  .pw { display: grid; grid-template-columns: auto 1fr; gap: 8px 12px; align-items: center; margin: 12px 0; }
  .pw label { justify-self: end; font-size: 13px; color: var(--text2); }
  .pw input {
    font: inherit; font-size: 13.5px; color: var(--text); background: var(--main);
    border: 1px solid var(--hair); border-radius: 7px; padding: 5px 8px; max-width: 220px;
  }
  .vaultacts { display: flex; flex-wrap: wrap; gap: 4px 18px; }
  .merges { margin: 4px 0 8px 18px; padding: 0; font-size: 12px; color: var(--text2); }
  .mfile { color: var(--text); font-weight: 600; }
  .mwhen { color: var(--text3); margin-left: 6px; }
  .folder { font-weight: 600; }
  .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
  .checkok { color: var(--accent); }
  .checkbad { color: var(--dead); }
  .checkfails { margin: 4px 0 0 18px; padding: 0; font-size: 12px; color: var(--text2); }
  .linkish:disabled { opacity: .5; cursor: default; }
  .linkish { font: inherit; font-size: 13px; color: var(--accent); background: none; border: 0; padding: 2px 0; cursor: pointer; }
  button.primary {
    font: inherit; font-size: 13.5px; color: #fff; background: var(--accent);
    border: 0; border-radius: 7px; padding: 6px 14px; cursor: pointer;
  }
  button.primary:disabled { opacity: .45; cursor: default; }
  a.mail { display: inline-block; color: #fff; background: var(--accent); border-radius: 6px; padding: 5px 12px; font-size: 13px; text-decoration: none; }
  .devices li.asked { color: var(--text2); font-size: 12.5px; border-bottom: 1px solid var(--hair); padding-top: 0; }
  .tut { margin: 18px 0 0; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .tut .note { margin: 0; }
  @media (max-width: 720px), (pointer: coarse) and (max-width: 899px), (pointer: coarse) and (max-height: 559px) { .pw { grid-template-columns: 1fr; } .pw label { justify-self: start; } }
  @media (max-width: 720px), (pointer: coarse) and (max-width: 899px), (pointer: coarse) and (max-height: 559px) {
    .sheet {
      width: calc(100vw - 16px);
      top: calc(env(safe-area-inset-top) + 10px);
      max-height: calc(100vh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 20px);
    }
    .panes { padding: 4px 4px 8px; gap: 0; }
    .panes button { font-size: 10px; padding: 7px 1px; }
    .grid { grid-template-columns: 1fr; gap: 4px; }
    .grid label { justify-self: start; text-align: left; color: var(--text2); font-size: 12px; margin-top: 8px; }
  }
</style>
