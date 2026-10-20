<script>
  import Icon from './Icon.svelte';
  import { app } from '../lib/store.svelte.js';
  /** Short empty copy per list. */
  const COPY = {
    inbox: { icon: 'emptyBox', title: 'Inbox is empty', text: 'Anything on your mind goes here first. Decide when to start it later.' },
    today: { icon: 'emptyToday', title: 'Nothing planned for today', text: 'Pick a few things from Anytime, or enjoy the quiet.' },
    upcoming: { icon: 'emptyCal', title: 'Nothing scheduled', text: 'To-dos with a start date or a deadline show up here.' },
    anytime: { icon: 'emptyLayers', title: 'Nothing here yet', text: 'To-dos you can start any time live here.' },
    someday: { icon: 'emptyArchive', title: 'Nothing in Someday', text: 'Park ideas here for later, without committing to a date.' },
    logbook: { icon: 'emptyCheck', title: 'The Logbook is empty', text: 'Completed to-dos and projects are kept here.' },
    trash: { icon: 'emptyTrash', title: 'Trash is empty', text: 'Deleted to-dos wait here until you empty the trash.' },
    project: { icon: 'emptyCircle', title: 'No to-dos yet', text: 'Add the first step to this project.' },
    area: { icon: 'emptyArea', title: 'Nothing in this area', text: 'Projects and to-dos you file here will appear.' },
    filter: { icon: 'emptyLayers', title: 'No to-dos with this tag', text: 'Pick another tag or show all.' }
  };
  let { kind = 'inbox', title, text } = $props();
  // No server and no kept copy of this list: say that, not "Nothing planned".
  // An empty day and an unreachable server look identical from a list, and
  // the second one dressed as the first is the offline bug in one sentence.
  let unreachable = $derived(!app.online && !app.data);
  let c = $derived(unreachable
    ? { icon: 'emptyLayers', title: "Can't reach the server", text: "This list hasn't been opened on this device while online, so there is no copy to show." }
    : (COPY[kind] || COPY.inbox));
</script>

<div class="empty" role="status">
  <span class="eic"><Icon name={c.icon} /></span>
  <b>{title || c.title}</b>{text || c.text}
</div>
