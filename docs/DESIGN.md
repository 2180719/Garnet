# Garnet visual identity

Garnet feels like a personal instrument: precise, readable, and recognizably its own.
The public site introduces that identity; the dashboard and terminal use it at working density.

## Palette

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | `#f5f5f2` | `#101113` |
| Ink | `#17181b` | `#f5f5f2` |
| Garnet accent | `#c51d3a` | `#ff6680` |
| Secondary text | `#666970` | `#a3a6ad` |
| Rule | `#d4d5d3` | `#303238` |

Use garnet red for identity, selection, and primary action. Reserve green, amber, and error red for actual states. Terminal specimens use charcoal with the dark accent in both themes.

## Form and typography

- Use system sans for headings and body, monospace for commands, metadata, and numbered section labels. No remote fonts.
- The lowercase `garnet.` wordmark is the public site's signature. Keep its tight spacing within the wordmark; keep body text comfortably spaced.
- Use straight rules, 2–3px corners, and restrained offset shadows. Avoid soft floating cards and decorative gradients.
- The site uses large type and generous space. The dashboard uses the same palette, headings, rules, and controls at a denser scale.
- Use the existing faceted gem for the icon. In terminals, `◆ GARNET` is the compact signature.

## Terminal

`garnet chat` adds its garnet signature, colored speaker marks (`›` for the owner, `◆` for Garnet) and thin rules only on an interactive terminal. Respect `NO_COLOR` and `TERM=dumb`; piped output stays plain. Never decorate machine-readable output.

The chat is an inline TUI, not a full-screen one: finished output goes to the terminal's own scrollback, and only the bottom rows (streaming text, spinner, input, footer) are redrawn. It uses the dark palette (accent, secondary text, rule) with green, amber and red reserved for states, and spells out every status in words or distinct symbols. Color is never the only indicator.

## Interaction

Visible keyboard focus, native buttons and links, readable contrast, and reduced-motion support are part of the identity. The public site's surface switcher is a local illustrative preview, not a live agent or dashboard. Preserve that distinction in future changes.

## Implementation

`site/styles.css` and `dashboard/styles.css` carry matching tokens in their standalone bundles. Keep them synchronized: the dashboard's strict CSP and independent static serving do not allow a remote stylesheet dependency. Terminal styling lives in `src/cli/chat/theme.ts` and `src/cli/chat/render.ts`.
