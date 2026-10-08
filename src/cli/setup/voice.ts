// Voice notes: which speech-to-text service turns them into text. Audio is sent to that service, so the
// default is off and the question says where it goes. A `command` backend set in config is kept as it is.
import { CONFIG_VERSION, keyEnvOf, listProviders, parseConfig, type GarnetConfig } from '../../config/index.ts';
import type { Io } from '../main.ts';
import type { Choice, Prompter } from './prompt.ts';
import { secretStep } from './secrets.ts';
import { heading, required, validEnvName, validUrl, type SetupDeps, type State } from './shared.ts';

type Transcription = GarnetConfig['media']['transcription'];
type Service = 'none' | 'openai' | 'groq' | 'other' | 'command';

const SERVICES = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', keyEnv: 'OPENAI_API_KEY', keyHelp: 'Create one at https://platform.openai.com/api-keys' },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', keyEnv: 'GROQ_API_KEY', keyHelp: 'Create one at https://console.groq.com/keys' },
} as const;

export function serviceOf(t: Transcription): Service {
  if (t.backend === 'none') return 'none';
  if (t.backend === 'command') return 'command';
  const host = t.baseUrl ? new URL(t.baseUrl).host : '';
  return host === 'api.openai.com' ? 'openai' : host === 'api.groq.com' ? 'groq' : 'other';
}

const origin = (url: string | undefined): string => {
  try {
    return url ? new URL(url).origin : '';
  } catch {
    return '';
  }
};

/** True when a model provider on another host already reads the secret called `name`. */
const usedByOtherHost = (c: GarnetConfig, name: string, baseUrl: string): boolean =>
  listProviders(c).some((x) => keyEnvOf(x.model) === name && origin(x.model.baseUrl ?? (x.model.provider === 'anthropic' ? 'https://api.anthropic.com' : undefined)) !== origin(baseUrl));

export async function voiceStep(p: Prompter, io: Io, deps: SetupDeps, st: State): Promise<void> {
  const s = deps.style;
  heading(io, s, 'Voice notes');
  const cur = st.config.media.transcription;
  const now = serviceOf(cur);
  const choices: Choice<Service>[] = [
    { value: 'none', label: 'No, leave voice notes alone', hint: 'Garnet says it cannot listen to them' },
    { value: 'openai', label: 'OpenAI Whisper', hint: 'audio is sent to OpenAI · API key' },
    { value: 'groq', label: 'Groq Whisper', hint: 'audio is sent to Groq · fast, API key' },
    { value: 'other', label: 'A server I run, or another compatible API', hint: 'a local whisper.cpp or speaches server needs no key' },
    ...(now === 'command' ? [{ value: 'command' as const, label: 'The local command already set up', hint: 'edit it with `garnet config`' }] : []),
  ];
  const service = await p.select<Service>({
    id: 'voice',
    message: 'Should Garnet understand voice notes?',
    help: 'It turns the audio into text first. Chats and /attach in the terminal both use it.',
    choices,
    default: now,
    auto: now,
  });
  let next: Transcription;
  if (service === 'none') next = { ...cur, backend: 'none' };
  else if (service === 'command') next = cur;
  else if (service === 'other') {
    const baseUrl = await p.text({
      id: 'voice-url',
      message: 'API base address',
      help: 'Ending in /v1, for example http://127.0.0.1:8080/v1 for a local server.',
      ...(cur.baseUrl && now === 'other' ? { default: cur.baseUrl } : {}),
      validate: validUrl,
    });
    const model = await p.text({ id: 'voice-model', message: 'Transcription model name', default: cur.model, validate: required('a model name') });
    // Another service's key is never offered to this address.
    const sameAddress = (url: string) => now === 'other' && origin(url) === origin(cur.baseUrl);
    const was = sameAddress(baseUrl) ? (cur.apiKeyEnv ?? '') : '';
    const keyEnv = await p.text({ id: 'voice-key-env', message: 'Name of the secret that holds its key (empty if it needs none)', default: was, auto: was, validate: (v) => (v === '' ? null : validEnvName(v)) });
    const { apiKeyEnv: _old, ...rest } = cur;
    next = { ...rest, backend: 'openai-compatible', baseUrl, model, ...(keyEnv ? { apiKeyEnv: keyEnv } : {}) };
    if (keyEnv) await secretStep(p, io, deps, st, { id: 'voice-key', name: keyEnv, label: 'transcription API key', help: 'Press Enter to skip it.', required: false }, false);
  } else {
    const svc = SERVICES[service];
    // A name another provider's key already uses (say OPENAI_API_KEY for some other OpenAI-compatible host) is not reused.
    const own = now === service && cur.apiKeyEnv ? cur.apiKeyEnv : svc.keyEnv;
    const name = usedByOtherHost(st.config, own, svc.baseUrl) ? `${svc.keyEnv.replace(/_API_KEY$/, '')}_TRANSCRIBE_API_KEY` : own;
    next = { ...cur, backend: 'openai-compatible', baseUrl: svc.baseUrl, model: now === service ? cur.model : svc.model, apiKeyEnv: name };
    await secretStep(p, io, deps, st, { id: 'voice-key', name, label: `${svc.label} API key`, help: svc.keyHelp, required: true }, false);
  }
  st.config = parseConfig({ ...st.config, media: { ...st.config.media, transcription: next }, version: CONFIG_VERSION });
}

export const voiceSummary = (c: GarnetConfig): string => {
  const t = c.media.transcription;
  return t.backend === 'none' ? 'off' : t.backend === 'command' ? 'local command' : `${serviceOf(t)} · ${t.model}`;
};
