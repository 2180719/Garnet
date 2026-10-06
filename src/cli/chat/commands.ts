// Slash commands: definitions, parsing and tab completion. Pure.

export type SlashCommand = {
  name: string;
  aliases?: string[];
  args?: string;
  description: string;
};

/** Every command here is backed by real behavior in the chat app. */
export const COMMANDS: readonly SlashCommand[] = [
  { name: 'help', aliases: ['?'], description: 'Show commands and keyboard shortcuts' },
  { name: 'new', description: 'Start a new session' },
  { name: 'sessions', description: 'List recent sessions' },
  { name: 'resume', args: '<session-id>', description: 'Switch to an earlier session' },
  { name: 'model', description: 'Show the model and its context window' },
  { name: 'usage', aliases: ['cost'], description: 'Token usage for this session and the budget per task' },
  { name: 'compact', description: 'Summarize older turns now to free context' },
  { name: 'expand', args: '[n]', description: 'Show the full output of the last (or nth-last) tool call' },
  { name: 'clear', description: 'Clear the screen (the session continues)' },
  { name: 'exit', aliases: ['quit', 'q'], description: 'Leave the chat' },
];

export type ParsedSlash = { command: SlashCommand; args: string } | { unknown: string } | null;

/** Parses `/name args`. Null when the text is not a slash command (`//text` sends `/text`). */
export function parseSlash(text: string): ParsedSlash {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  const m = /^\/(\S*)\s*([\s\S]*)$/.exec(trimmed)!;
  const name = m[1]!.toLowerCase();
  const command = COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
  return command ? { command, args: m[2]!.trim() } : { unknown: name };
}

/** Text to send as a message: `//text` is an escaped leading slash. */
export function messageText(text: string): string {
  return text.trimStart().startsWith('//') ? text.trimStart().slice(1) : text;
}

/** Commands whose name starts with what is typed after `/` (for the suggestion list). */
export function matchingCommands(text: string): SlashCommand[] {
  const m = /^\/(\S*)$/.exec(text);
  if (!m) return [];
  const prefix = m[1]!.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(prefix));
}

export type Completion = { text: string; candidates: string[] };

/**
 * Tab completion for a command name, or for the argument of `/resume`
 * (`argCandidates` supplies session ids). With several matches it completes
 * their common prefix; when that adds nothing it takes the first match.
 */
export function complete(text: string, argCandidates: (command: string) => string[] = () => []): Completion {
  const nameOnly = /^\/(\S*)$/.exec(text);
  if (nameOnly) {
    const names = matchingCommands(text).map((c) => c.name);
    return choose(text, '/', nameOnly[1]!, names, ' ');
  }
  const withArg = /^\/(\S+)\s+(\S*)$/.exec(text);
  if (withArg) {
    const parsed = parseSlash(`/${withArg[1]}`);
    if (parsed && 'command' in parsed && parsed.command.args) {
      const options = argCandidates(parsed.command.name).filter((o) => o.startsWith(withArg[2]!));
      return choose(text, `/${withArg[1]} `, withArg[2]!, options, '');
    }
  }
  return { text, candidates: [] };
}

function choose(text: string, head: string, typed: string, options: string[], suffix: string): Completion {
  if (options.length === 0) return { text, candidates: [] };
  if (options.length === 1) return { text: `${head}${options[0]}${suffix}`, candidates: options };
  const common = commonPrefix(options);
  if (common.length > typed.length) return { text: `${head}${common}`, candidates: options };
  return { text: `${head}${options[0]}`, candidates: options };
}

function commonPrefix(items: string[]): string {
  let prefix = items[0] ?? '';
  for (const s of items) while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}

export const SHORTCUTS: readonly [string, string][] = [
  ['Enter', 'send'],
  ['Shift+Enter, Alt+Enter, Ctrl+J, or \\ then Enter', 'new line'],
  ['Up / Down', 'previous / next message from history (or move between lines)'],
  ['Tab', 'complete a /command or session id'],
  ['Esc or Ctrl+C', 'interrupt Ruby while it works'],
  ['Ctrl+C', 'clear the input; twice on an empty line to exit'],
  ['Ctrl+D', 'exit (on an empty line)'],
  ['Ctrl+L', 'clear the screen'],
  ['Ctrl+A / Ctrl+E', 'start / end of line'],
  ['Ctrl+W, Alt+Backspace', 'delete the previous word'],
  ['Ctrl+U / Ctrl+K', 'delete to start / end of line'],
  ['//text', 'send a message that starts with /'],
  [' text (leading space)', 'send without saving to history'],
];
