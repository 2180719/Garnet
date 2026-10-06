import type { ApplyResult, ImportPlan } from './types.ts';

const one = (s: string) => s.replace(/\s+/g, ' ');

export function formatPlan(plan: ImportPlan): string {
  const L: string[] = [];
  const name = plan.source === 'openclaw' ? 'OpenClaw' : 'Hermes Agent';
  L.push(`Import from ${name}: ${plan.fromDir}`);
  if (plan.contentDir !== plan.fromDir) L.push(`Reading workspace files from ${plan.contentDir}`);
  L.push('');

  L.push('Memory');
  if (!plan.memory.length) L.push('  nothing found');
  for (const m of plan.memory) {
    const label = m.file === 'memory' ? 'MEMORY.md' : 'USER.md';
    L.push(`  ${m.from} -> Ruby ${label}: ${m.entries.length} entries; ${m.fitCount} fit the ${m.cap}-char cap (most recent kept)`);
    if (m.fitCount < m.entries.length) L.push(`    ${m.entries.length - m.fitCount} older entries will not fit; the full file is archived (see below). Curate with \`ruby memory edit ${m.file}\`.`);
    if (m.shortened) L.push(`    ${m.shortened} entries are over 500 chars and will be shortened.`);
    for (const s of m.skipped) L.push(`    skipped "${s.text}": ${s.reason}`);
  }

  L.push('', 'Persona');
  if (!plan.persona) L.push('  nothing found');
  else {
    L.push(`  ${plan.persona.from.join(' + ')} -> config persona (${plan.persona.text.length}/4000 chars${plan.persona.truncated ? ', TRUNCATED; originals archived' : ''})`);
    L.push('  An existing different persona is never overwritten.');
  }

  L.push('', 'Skills');
  if (!plan.skills.length) L.push('  none found');
  for (const s of plan.skills) {
    const rename = s.name && s.name !== s.originalName ? ` (renamed from "${s.originalName}")` : '';
    if (s.conflict) L.push(`  SKIP ${s.name || s.originalName}: ${s.conflict}`);
    else L.push(`  ${s.name}${rename}: ${one(s.description)}${s.extraFiles.length ? ` [+${s.extraFiles.length} supporting files archived]` : ''}${s.bodyTruncated ? ' [body truncated]' : ''}`);
  }
  if (plan.skills.length) L.push('  Skills that already exist in Ruby are left untouched.');

  L.push('', `Archived copies under <workspace>/imported/${plan.source}/ (${plan.copies.length})`);
  for (const c of plan.copies.slice(0, 40)) L.push(`  ${c.src}: ${c.reason}`);
  if (plan.copies.length > 40) L.push(`  ... and ${plan.copies.length - 40} more`);

  L.push('', 'Not imported');
  if (!plan.notImported.length) L.push('  nothing notable');
  for (const n of plan.notImported) L.push(`  ${n.what}: ${n.why}`);
  if (plan.envVars.length) {
    L.push('', 'Environment variables you may need in ~/.ruby/env (names only; set the values yourself):');
    L.push(`  ${plan.envVars.join(', ')}`);
  }
  if (plan.warnings.length) {
    L.push('', 'Warnings');
    for (const w of plan.warnings) L.push(`  ${w}`);
  }
  return `${L.join('\n')}\n`;
}

export function formatResult(r: ApplyResult): string {
  const L: string[] = ['Applied:'];
  for (const m of r.memory) L.push(`  ${m.file}: ${m.added} added, ${m.alreadyPresent} already present, ${m.omittedForCap} left out for the cap (${m.used}/${m.limit} chars)`);
  L.push(`  persona: ${r.persona}`);
  for (const s of r.skills) L.push(`  skill ${s.name}: ${s.status}${s.detail ? ` (${s.detail})` : ''}`);
  const by = (st: string) => r.copied.filter((c) => c.status === st).length;
  L.push(`  files: ${by('copied')} copied, ${by('exists')} already there, ${by('failed')} failed`);
  for (const c of r.copied.filter((x) => x.status === 'failed')) L.push(`    ${c.dest}: ${c.detail}`);
  return `${L.join('\n')}\n`;
}
