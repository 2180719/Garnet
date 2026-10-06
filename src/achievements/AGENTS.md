# achievements

Unlockable milestones and easter eggs, shown in the dashboard. Purely local: nothing is reported anywhere.

- Public API: `Achievements` (evaluate, unlock, unlockEasterEgg, list), `ACHIEVEMENTS`, `Stats`.
- Earned achievements are judged from `Stats` gathered by the composition root; unlocks are stored with their date and never removed.
- `clientUnlock` marks harmless easter eggs (Konami code, clicking the gem, `ruby --sparkle`) that the dashboard or CLI may unlock directly. Everything else must be earned.
- Adding one: append to `ACHIEVEMENTS` with a stable `id` (never rename or reuse ids), and add the stat it needs to `Stats` if necessary.
