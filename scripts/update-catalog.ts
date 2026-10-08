// Regenerates src/catalog/snapshot.json from OpenRouter's public model list: `npm run catalog:update`.
// Run it before a release and commit the result; installs refresh their own cache when a provider is added.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPENROUTER_MODELS_URL, parseOpenRouter } from '../src/catalog/index.ts';

const res = await fetch(OPENROUTER_MODELS_URL);
if (!res.ok) throw new Error(`${OPENROUTER_MODELS_URL}: HTTP ${res.status}`);
const models = parseOpenRouter(await res.json()).sort((a, b) => a.id.localeCompare(b.id));
// One model per line keeps diffs reviewable.
const body = `{"fetchedAt":${JSON.stringify(new Date().toISOString())},"models":[\n${models.map((m) => JSON.stringify(m)).join(',\n')}\n]}\n`;
writeFileSync(join(import.meta.dirname, '..', 'src', 'catalog', 'snapshot.json'), body);
console.log(`Wrote ${models.length} models.`);
