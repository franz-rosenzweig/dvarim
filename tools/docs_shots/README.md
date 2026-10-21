# The pictures in the docs

Every picture in `docs/images` but the icon is taken by `shoot.py`, from a demo
vault, in the real web app, so a change to the look is one command away from
pictures that show it:

```bash
frontend/build.sh                      # the pictures show what is in frontend/dist
python3 tools/docs_shots/shoot.py      # all of them, into docs/images
```

Then look at every one against the one it replaces (`git diff --stat` says
which changed; open them) before committing.

It needs Docker, the Chrome container `docker-chrome-1` with DevTools on :9222,
the images `node:22-alpine` and `tomsquest/docker-radicale`, and Python with
`httpx`, `websockets` and `Pillow`. Everything it starts is a throwaway named
`dvarim-docs-*`, on ports 8521–8524 and 8529 inside the Chrome container's
network, and it removes them all when it's done. It never goes near a real
vault, the live server or the real calendars.

## The files

| File | What it is |
| --- | --- |
| `demo_vault.py` | the vault the pictures show: three areas, their projects, Today's ten to-dos, the Logbook's week, Someday. `demo_vault.py DEST` writes one on its own |
| `shoot.py` | the stack (Radicale with the Work and Home calendars, four sandbox servers), one scene per picture, and the frames |
| `clock.mjs` | moves a sandbox server's clock to the shoot day |

## Worth knowing

- **The shoot day is a Sunday**, the latest one, at 16:00 in Phoenix, and both
  the servers and the page are moved there. The docs name weekdays ("Tuesday
  with an event", "yesterday, Friday, Thursday"), so the pictures always show
  the same ones. `--today YYYY-MM-DD` picks another day.
- **One picture or a few**: `--only when,deadline --out /tmp/shots`.
  `--list` names them all.
- **Looking around**: `--keep --work /tmp/dv-shots` leaves the stack running
  and the scratch folder in place (its `stack.json` has the sandbox passwords);
  `--attach --work /tmp/dv-shots` takes pictures with that stack again. Remove
  it afterwards with `docker rm -f $(docker ps -aq --filter name=dvarim-docs-)`.
- **The frames are measured, not designed**: the window's radius, outline and
  shadow, and the phone's body, are the ones the earlier pictures had, to the
  pixel. Change `WINDOWS` or `PHONE_FRAME` in `shoot.py` only on purpose.
- **Fonts**: the browser has no SF Pro, so the page is set in Inter and its
  code in FreeMono, as before. The Markdown beside the app in `files.png` is a
  plain editor drawn by `shoot.py` (`editor_html`), not the app.
- **Headless Chrome paints no text caret**, so the share sheet's is drawn in,
  where the page says the caret is.
