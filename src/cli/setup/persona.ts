// The persona basics `ruby setup` manages (assistant name, owner name, notes)
// live in a marked block inside config.persona, so re-running setup updates
// them without touching persona text written by hand or imported.

const START = '<!-- ruby setup -->';
const END = '<!-- /ruby setup -->';
export const DEFAULT_NAME = 'Ruby';
export const PERSONA_MAX = 4000;

export type PersonaBasics = { name: string; owner: string; notes: string };

function split(persona: string | undefined): { block: string | null; rest: string } {
  const text = persona ?? '';
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a < 0 || b < a) return { block: null, rest: text.trim() };
  return { block: text.slice(a + START.length, b), rest: (text.slice(0, a) + text.slice(b + END.length)).trim() };
}

/** The basics recorded by a previous setup run, or defaults. */
export function readPersona(persona: string | undefined): PersonaBasics {
  const { block } = split(persona);
  const get = (re: RegExp) => (block ? (re.exec(block)?.[1]?.trim() ?? '') : '');
  return {
    name: get(/^Your name is (.+)\.$/m) || DEFAULT_NAME,
    owner: get(/^The person you work for is (.+?)\. Address them as .+\.$/m),
    notes: get(/^Their preferences: (.+)$/m),
  };
}

/** Returns config.persona with the setup block replaced (or removed when everything is default). */
export function writePersona(persona: string | undefined, b: PersonaBasics): string | undefined {
  const { rest } = split(persona);
  const lines: string[] = [];
  const name = b.name.trim() || DEFAULT_NAME;
  const owner = b.owner.trim();
  const notes = b.notes.trim();
  if (name !== DEFAULT_NAME || owner || notes) {
    lines.push(`Your name is ${name}.`);
    if (owner) lines.push(`The person you work for is ${owner}. Address them as ${owner}.`);
    if (notes) lines.push(`Their preferences: ${notes}`);
  }
  const block = lines.length ? `${START}\n${lines.join('\n')}\n${END}` : '';
  const out = [block, rest].filter(Boolean).join('\n\n');
  return out || undefined;
}

/** Single-line, short answers only (they go into the system prompt). */
export function validBasic(max: number) {
  return (v: string): string | null => {
    if (/[\r\n]/.test(v)) return 'Use a single line.';
    if (v.includes('<!--') || v.includes('-->')) return 'Leave out HTML comment markers.';
    return v.length > max ? `Keep it under ${max} characters.` : null;
  };
}
