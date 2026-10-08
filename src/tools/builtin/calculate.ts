import { z } from 'zod';
import { GarnetError, type ToolDefinition } from '../../contracts/index.ts';

const FUNCTIONS: Record<string, { arity: number | 'many'; fn: (...a: number[]) => number }> = {
  sqrt: { arity: 1, fn: Math.sqrt },
  cbrt: { arity: 1, fn: Math.cbrt },
  abs: { arity: 1, fn: Math.abs },
  round: { arity: 1, fn: Math.round },
  floor: { arity: 1, fn: Math.floor },
  ceil: { arity: 1, fn: Math.ceil },
  ln: { arity: 1, fn: Math.log },
  log: { arity: 1, fn: Math.log10 },
  log2: { arity: 1, fn: Math.log2 },
  exp: { arity: 1, fn: Math.exp },
  sin: { arity: 1, fn: Math.sin },
  cos: { arity: 1, fn: Math.cos },
  tan: { arity: 1, fn: Math.tan },
  asin: { arity: 1, fn: Math.asin },
  acos: { arity: 1, fn: Math.acos },
  atan: { arity: 1, fn: Math.atan },
  pow: { arity: 2, fn: Math.pow },
  min: { arity: 'many', fn: Math.min },
  max: { arity: 'many', fn: Math.max },
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

type Token = { kind: 'num'; value: number } | { kind: 'id'; value: string } | { kind: 'op'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_]\w*)|(\*\*|[-+*/%^(),]))/y;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) {
      if (src.slice(pos).trim() === '') break;
      throw new GarnetError('invalid_input', `Unexpected character "${src.slice(pos).trim()[0]}" in the expression.`);
    }
    pos = re.lastIndex;
    if (m[1] !== undefined) {
      const value = Number(m[1]);
      // Doubles hold integers exactly only up to 2^53; a longer literal would be silently rounded.
      if (/^\d+$/.test(m[1]) && !Number.isSafeInteger(value)) throw new GarnetError('invalid_input', `${m[1]} is too large to calculate exactly (integers above ${Number.MAX_SAFE_INTEGER} lose digits). Use scientific notation if an approximation is fine.`);
      tokens.push({ kind: 'num', value });
    }
    else if (m[2] !== undefined) tokens.push({ kind: 'id', value: m[2].toLowerCase() });
    else tokens.push({ kind: 'op', value: m[3]! });
  }
  return tokens;
}

/**
 * Evaluates an arithmetic expression with a small recursive-descent parser. There is no `eval`: only numbers,
 * `+ - * / % ^ **`, parentheses, the constants and functions above. Precedence: unary minus binds looser than
 * `^` (so `-2^2` is -4), and `^` is right-associative.
 */
export function evaluate(src: string): number {
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (v: string) => peek()?.kind === 'op' && peek()!.value === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new GarnetError('invalid_input', `Expected "${v}" in the expression.`);
    i += 1;
  };

  const expr = (): number => {
    let left = term();
    while (isOp('+') || isOp('-')) {
      const op = tokens[i++]!.value;
      const right = term();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };
  const term = (): number => {
    let left = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = tokens[i++]!.value;
      const right = unary();
      if ((op === '/' || op === '%') && right === 0) throw new GarnetError('invalid_input', 'Division by zero.');
      left = op === '*' ? left * right : op === '/' ? left / right : left % right;
    }
    return left;
  };
  const unary = (): number => {
    if (isOp('-')) {
      i += 1;
      return -unary();
    }
    if (isOp('+')) {
      i += 1;
      return unary();
    }
    return power();
  };
  const power = (): number => {
    const base = atom();
    if (isOp('^') || isOp('**')) {
      i += 1;
      return Math.pow(base, unary());
    }
    return base;
  };
  const atom = (): number => {
    const t = tokens[i++];
    if (!t) throw new GarnetError('invalid_input', 'The expression ends unexpectedly.');
    if (t.kind === 'num') return t.value;
    if (t.kind === 'op' && t.value === '(') {
      const v = expr();
      expect(')');
      return v;
    }
    if (t.kind === 'id') {
      if (isOp('(')) {
        const f = FUNCTIONS[t.value];
        if (!f) throw new GarnetError('invalid_input', `Unknown function "${t.value}". Available: ${Object.keys(FUNCTIONS).join(', ')}.`);
        i += 1;
        const args: number[] = [];
        if (!isOp(')')) {
          do args.push(expr());
          while (isOp(',') && ++i);
        }
        expect(')');
        if (f.arity === 'many' ? args.length === 0 : args.length !== f.arity) {
          throw new GarnetError('invalid_input', `${t.value}() takes ${f.arity === 'many' ? 'at least one argument' : `${f.arity} argument(s)`}.`);
        }
        return f.fn(...args);
      }
      const c = CONSTANTS[t.value];
      if (c === undefined) throw new GarnetError('invalid_input', `Unknown name "${t.value}". Constants: ${Object.keys(CONSTANTS).join(', ')}.`);
      return c;
    }
    throw new GarnetError('invalid_input', `Unexpected "${t.value}" in the expression.`);
  };

  const result = expr();
  if (i < tokens.length) throw new GarnetError('invalid_input', `Unexpected "${(tokens[i] as { value: unknown }).value}" in the expression.`);
  return result;
}

/** `calculate`: exact arithmetic the model should not do in its head. Reads nothing and changes nothing. */
export const calculateTool: ToolDefinition<{ expression: string }> = {
  name: 'calculate',
  version: 1,
  description: 'Evaluate an arithmetic expression: + - * / % ^, parentheses, pi, e, and functions like sqrt, round, log, ln, sin, pow, min, max. Use it instead of doing math in your head.',
  input: z.object({ expression: z.string().min(1).max(500).describe('For example: 0.15 * (1250 + 80) or sqrt(2) ^ 3.') }),
  capability: 'fs.read',
  capabilitiesFor: () => [],
  idempotent: true,
  async run({ expression }) {
    const value = evaluate(expression);
    if (!Number.isFinite(value)) throw new GarnetError('invalid_input', 'The result is not a finite number (check for sqrt of a negative number, log of zero or overflow).');
    return { content: `${expression} = ${Number(value.toPrecision(15))}` };
  },
};
