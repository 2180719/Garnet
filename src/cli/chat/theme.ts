// Garnet's terminal palette (docs/DESIGN.md, dark column). Pure.

export type Style = (text: string) => string;

export type Theme = {
  /** False when styles are disabled entirely (plain output). */
  styled: boolean;
  /** False under NO_COLOR: bold/dim/italic remain, colors do not. */
  color: boolean;
  accent: Style;
  muted: Style;
  rule: Style;
  ok: Style;
  warn: Style;
  error: Style;
  code: Style;
  bold: Style;
  dim: Style;
  italic: Style;
  underline: Style;
  strike: Style;
  inverse: Style;
};

type Rgb = readonly [number, number, number];

const PALETTE = {
  accent: { rgb: [232, 89, 107], x256: 204 },
  muted: { rgb: [180, 168, 172], x256: 248 },
  rule: { rgb: [61, 47, 53], x256: 239 },
  ok: { rgb: [95, 208, 142], x256: 114 },
  warn: { rgb: [240, 180, 90], x256: 179 },
  error: { rgb: [255, 141, 155], x256: 203 },
  code: { rgb: [253, 179, 192], x256: 217 },
} as const satisfies Record<string, { rgb: Rgb; x256: number }>;

const sgr = (open: string, close: string): Style => (text) => (text ? `\x1b[${open}m${text}\x1b[${close}m` : text);
const identity: Style = (text) => text;

export type ThemeOptions = { styled: boolean; color: boolean; truecolor: boolean };

export function makeTheme(options: ThemeOptions): Theme {
  if (!options.styled) {
    return {
      styled: false, color: false,
      accent: identity, muted: identity, rule: identity, ok: identity, warn: identity, error: identity,
      code: identity, bold: identity, dim: identity, italic: identity, underline: identity, strike: identity, inverse: identity,
    };
  }
  const fg = (name: keyof typeof PALETTE): Style => {
    if (!options.color) return name === 'muted' || name === 'rule' ? sgr('2', '22') : identity;
    const c = PALETTE[name];
    return sgr(options.truecolor ? `38;2;${c.rgb.join(';')}` : `38;5;${c.x256}`, '39');
  };
  return {
    styled: true,
    color: options.color,
    accent: fg('accent'),
    muted: fg('muted'),
    rule: fg('rule'),
    ok: fg('ok'),
    warn: fg('warn'),
    error: fg('error'),
    code: fg('code'),
    bold: sgr('1', '22'),
    dim: sgr('2', '22'),
    italic: sgr('3', '23'),
    underline: sgr('4', '24'),
    strike: sgr('9', '29'),
    inverse: sgr('7', '27'),
  };
}

/** Decides styling from the environment: NO_COLOR, TERM=dumb and non-TTY output all disable color. */
export function themeFor(env: NodeJS.ProcessEnv, isTty: boolean): Theme {
  const dumb = env.TERM === 'dumb';
  const styled = isTty && !dumb;
  const color = styled && !('NO_COLOR' in env);
  const truecolor = /^(truecolor|24bit)$/i.test(env.COLORTERM ?? '');
  return makeTheme({ styled, color, truecolor });
}
