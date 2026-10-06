# Garnet visual identity

Garnet feels like a personal instrument: precise, readable, and recognizably its own.
The public site introduces that identity; the dashboard and terminal use it at working density.

## Color palette

Colors are derived from the deep wine and rose hues of garnet gemstones, with warm neutral greys and reserved status colors (green, amber, error red).

### Light theme

| Token | Hex | RGB | Usage |
| --- | --- | --- | --- |
| Canvas | `#faf9f8` | 250, 249, 248 | Page background |
| Ink | `#16141a` | 22, 20, 26 | Body text |
| Primary accent | `#8b1a1a` | 139, 26, 26 | Links, active states, primary action |
| Secondary accent | `#d97a6f` | 217, 122, 111 | Hover states, lighter emphasis |
| Secondary text | `#6b7070` | 107, 112, 112 | Labels, muted text |
| Rule | `#d9d4d0` | 217, 212, 208 | Borders, dividers |
| Code background | `#f0eeec` | 240, 238, 236 | Inline code, pre blocks |
| Status OK | `#186a47` | 24, 106, 71 | Success states |
| Status warn | `#9a5b00` | 154, 91, 0 | Warnings, cautions |
| Status error | `#b81c3e` | 184, 28, 62 | Errors, denials |

### Dark theme

| Token | Hex | RGB | Usage |
| --- | --- | --- | --- |
| Canvas | `#0d0810` | 13, 8, 16 | Page background |
| Ink | `#f0e8ea` | 240, 232, 234 | Body text |
| Primary accent | `#e8596b` | 232, 89, 107 | Links, active states, primary action |
| Secondary accent | `#8d2e3d` | 141, 46, 61 | Darker accent for contrast |
| Secondary text | `#b4a8ac` | 180, 168, 172 | Labels, muted text |
| Rule | `#3d2f35` | 61, 47, 53 | Borders, dividers |
| Code background | `#1a0f18` | 26, 15, 24 | Inline code, pre blocks |
| Status OK | `#5fd08e` | 95, 208, 142 | Success states |
| Status warn | `#f0b45a` | 240, 180, 90 | Warnings, cautions |
| Status error | `#ff8d9b` | 255, 141, 155 | Errors, denials |

### Terminal (dark theme optimized)

| Token | RGB | Hex | 256-color | Usage |
| --- | --- | --- | --- | --- |
| Canvas | 13, 8, 16 | `#0d0810` | 16 | Terminal background |
| Ink | 240, 232, 234 | `#f0e8ea` | 253 | Terminal text |
| Accent | 232, 89, 107 | `#e8596b` | 204 | Speaker marks, emphasis |
| Secondary text | 180, 168, 172 | `#b4a8ac` | 248 | Muted text |
| Rule | 61, 47, 53 | `#3d2f35` | 239 | Dividers |
| Code/inline | 253, 179, 192 | `#fdafc0` | 217 | Inline code highlighting |
| Status OK | 95, 208, 142 | `#5fd08e` | 114 | Success ✓ |
| Status warn | 240, 180, 90 | `#f0b45a` | 179 | Warning ! |
| Status error | 255, 141, 155 | `#ff8d9b` | 203 | Error ✗ |

Use garnet red for identity, selection, and primary action. Reserve green, amber, and error red for actual states. Terminal specimens use the dark palette in both themes, with all status never conveyed by color alone—always include symbols (✓, !, ✗) and text labels.

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
