// Easter egg: `ruby --sparkle`.
const GEM = [
  '      ________      ',
  '     /\\  /\\  /\\     ',
  '    /__\\/__\\/__\\    ',
  '    \\  /\\  /\\  /    ',
  '     \\/  \\/  \\/     ',
  '      \\      /      ',
  '       \\    /       ',
  '        \\  /        ',
  '         \\/         ',
];

export function sparkle(color = process.stdout.isTTY ?? false): string {
  const red = (s: string) => (color ? `\x1b[38;5;161m${s}\x1b[0m` : s);
  const lines = GEM.map((l) => red(l.replace(/ (?=\S)/g, (m, i: number) => ((i * 7) % 11 === 0 ? '✦' : m))));
  return `${lines.join('\n')}\n\n   polished, not bloated.\n`;
}
