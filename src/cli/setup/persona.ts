// The persona questions, shared by the setup form and the onboarding fallback.
// The persona block itself (markers, reading, writing) lives in src/config.
import { DEFAULT_NAME, validBasic, type PersonaBasics } from '../../config/index.ts';
import type { Prompter } from './prompt.ts';

/** Asks the three persona questions. Only `text` is needed, so a line-based prompter is enough. */
export async function askBasics(p: Pick<Prompter, 'text'>, cur: PersonaBasics): Promise<PersonaBasics> {
  const name = await p.text({ id: 'name', message: 'What should your assistant be called?', default: cur.name, validate: validBasic(40) });
  const owner = await p.text({ id: 'owner', message: 'And what should it call you?', help: 'Optional. Press Enter to skip.', default: cur.owner, validate: validBasic(60) });
  const notes = await p.text({
    id: 'notes',
    message: 'Anything about how you like answers?',
    help: 'Optional, one line. For example: "Brief answers. I live in Lisbon and work in UTC."',
    default: cur.notes,
    validate: validBasic(500),
  });
  return { name: name || DEFAULT_NAME, owner, notes };
}
