# Ruby visual identity

Ruby feels like a personal instrument: precise, readable, and recognizably its own.
The public site introduces that identity; the dashboard and terminal use it at working density.

## Palette

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | `#f5f5f2` | `#101113` |
| Ink | `#17181b` | `#f5f5f2` |
| Ruby accent | `#c51d3a` | `#ff6680` |
| Secondary text | `#666970` | `#a3a6ad` |
| Rule | `#d4d5d3` | `#303238` |

Use ruby red for identity, selection, and primary action. Reserve green, amber, and error red for actual states. Terminal specimens use charcoal with the dark accent in both themes.

## Form and typography

- Use system sans for headings and body, monospace for commands, metadata, and numbered section labels. No remote fonts.
- The lowercase `ruby.` wordmark is the public site's signature. Keep its tight spacing within the wordmark; keep body text comfortably spaced.
- Use straight rules, 2–3px corners, and restrained offset shadows. Avoid soft floating cards and decorative gradients.
- The site uses large type and generous space. The dashboard uses the same palette, headings, rules, and controls at a denser scale.
- Use the existing faceted gem for the icon. In terminals, `◆ RUBY` is the compact signature.

## Terminal and future TUI

The existing CLI adds its ruby signature and colored speaker labels only on an interactive terminal. Respect `NO_COLOR` and `TERM=dumb`; piped output stays plain. Never decorate machine-readable output.

A future full-screen TUI should use the same charcoal/ruby palette, a narrow numbered navigation rail, thin box rules, and explicit text for every status. Color must never be the only indicator. There is no full-screen TUI today.

## Interaction

Visible keyboard focus, native buttons and links, readable contrast, and reduced-motion support are part of the identity. The public site's surface switcher is a local illustrative preview, not a live agent or dashboard. Preserve that distinction in future changes.

## Implementation

`site/styles.css` and `dashboard/styles.css` carry matching tokens in their standalone bundles. Keep them synchronized: the dashboard's strict CSP and independent static serving do not allow a remote stylesheet dependency. CLI identity lives in `src/cli/main.ts`.
