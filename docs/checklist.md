# Manual checklist (PLAN.md section 16, phase 9)

Run before the demo, from a cold start, three times.

- [ ] `scripts/dev.sh` starts both servers; `/api/health` answers; the phone opens the LAN URL
- [ ] Real sheet under three lighting conditions (window, room light, clip lamp)
- [ ] A sheet drawn with a thin pen: warning shown, level still plays
- [ ] A sheet with no goal: warning, goal placed on the rightmost ground column
- [ ] An impossible level: solver overlay shows the unreachable goal; publishing still works with the `solvable: false` badge
- [ ] A remix sheet: QR parsed, parent composed, child shows under the parent in the tree with the author's name
- [ ] "this platform moves" + arrow: the platform moves; key opens the door; handwritten text does not become tiles
- [ ] Network cable pulled: scan still produces a playable level (fake mode, `rules_not_read` warning)
- [ ] Canvas path produces a level without a camera
- [ ] Backup photos in `shared/fixtures/photos/real/` scan correctly
