import { z } from 'zod';
import {
  DEFAULT_NAME,
  PERSONA_MAX,
  loadConfig,
  readPersona,
  validBasic,
  validTimeZone,
  writeConfig,
  writePersona,
  type PersonaBasics,
} from '../config/index.ts';
import { GarnetError, type ToolDefinition } from '../contracts/index.ts';

export type ProfileUpdate = { name?: string | undefined; owner?: string | undefined; notes?: string | undefined; timezone?: string | undefined };

/**
 * Applies owner profile answers to config.json: the persona basics between the
 * `<!-- garnet setup -->` markers and the optional time zone. This is the same
 * code path `garnet setup` uses (readPersona/writePersona, validate, writeConfig).
 * Fields left out keep their current value. Returns what is now stored.
 */
export function applyProfile(home: string, update: ProfileUpdate): PersonaBasics & { timezone: string | undefined } {
  const checks: [string, string | undefined, number][] = [
    ['assistant_name', update.name, 40],
    ['owner_name', update.owner, 60],
    ['style_notes', update.notes, 500],
  ];
  for (const [field, value, max] of checks) {
    const problem = value === undefined ? null : validBasic(max)(value);
    if (problem) throw new GarnetError('invalid_input', `${field}: ${problem}`);
  }
  if (update.timezone !== undefined && !validTimeZone(update.timezone)) {
    throw new GarnetError('invalid_input', `timezone: "${update.timezone}" is not an IANA time zone. Use a name like Europe/Lisbon or America/New_York.`);
  }
  const { config } = loadConfig(home);
  const cur = readPersona(config.persona);
  const next: PersonaBasics = {
    name: update.name?.trim() || cur.name || DEFAULT_NAME,
    owner: update.owner?.trim() ?? cur.owner,
    notes: update.notes?.trim() ?? cur.notes,
  };
  const persona = writePersona(config.persona, next);
  if ((persona ?? '').length > PERSONA_MAX) {
    throw new GarnetError('invalid_input', `The persona would exceed ${PERSONA_MAX} characters. Use shorter text.`);
  }
  if (persona === undefined) delete config.persona;
  else config.persona = persona;
  if (update.timezone !== undefined) config.timezone = update.timezone;
  writeConfig(home, config);
  return { ...next, timezone: config.timezone };
}

const input = z.object({
  assistant_name: z.string().min(1).max(40).optional().describe('What the owner wants to call you. One line.'),
  owner_name: z.string().min(1).max(60).optional().describe('What you should call the owner. One line.'),
  style_notes: z.string().min(1).max(500).optional().describe('How the owner likes answers (length, tone, formatting, dislikes). One line.'),
  timezone: z.string().min(1).max(64).optional().describe('IANA time zone of the owner, e.g. Europe/Lisbon.'),
});

export type ProfileToolInput = z.infer<typeof input>;

/**
 * `set_profile`: records the answers from the wake-up conversation. Registered
 * only when Garnet is started for onboarding, so it is not in every session's
 * tool list. It needs the same permission as the memory tool: it writes a small,
 * length-capped owner profile, and a session that read untrusted content is
 * asked first like any other write.
 */
export function profileTool(home: string): ToolDefinition<ProfileToolInput> {
  return {
    name: 'set_profile',
    version: 1,
    description:
      'Save the owner profile from the first-run conversation: your name, what to call the owner, their answer style and time zone. ' +
      'Fields you omit keep their value. Applies from the next session.',
    input,
    capability: 'memory.write',
    idempotent: true,
    summarize: (i) =>
      `Save the owner profile: ${[
        i.assistant_name && `assistant name "${i.assistant_name}"`,
        i.owner_name && `owner name "${i.owner_name}"`,
        i.style_notes && `style notes "${i.style_notes}"`,
        i.timezone && `time zone ${i.timezone}`,
      ]
        .filter(Boolean)
        .join(', ')}`,
    async run(i) {
      const saved = applyProfile(home, { name: i.assistant_name, owner: i.owner_name, notes: i.style_notes, timezone: i.timezone });
      const parts = [`name ${saved.name}`, saved.owner && `owner ${saved.owner}`, saved.notes && 'style notes', saved.timezone && `time zone ${saved.timezone}`].filter(Boolean);
      return { content: `Saved profile (${parts.join(', ')}). It takes effect in the next session.`, data: saved };
    },
  };
}
