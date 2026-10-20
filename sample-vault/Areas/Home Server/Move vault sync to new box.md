---
id: pvault0001
type: project
status: open
created: 2026-09-05
---
Syncthing on both ends, vault stays git-tracked. Cut over on a quiet weekend.

## Prepare
- [x] Install Syncthing on the new box 🆔 vs0001aa ➕ 2026-09-05 ✅ 2026-09-18
- [ ] Check Syncthing conflicts on the vault #server 🆔 vs0002bb ➕ 2026-09-10 ⏳ 2026-09-19
    Look for *.sync-conflict-* files in Daily/ and Notes/.
    - [x] grep for sync-conflict
    - [ ] Resolve each by hand
    - [ ] Note the cause in the runbook
- [ ] Back up Kindle highlights 🌙 🆔 vs0003cc ➕ 2026-09-12 ⏳ 2026-09-19

## Cut over
- [ ] Cut over Syncthing to the new box 🆔 vs0004dd ➕ 2026-09-05 ⏳ 2026-09-26
    - [ ] Pause old folder
    - [ ] Add device id
    - [ ] Verify 2,868 files
