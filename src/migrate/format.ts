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
    L.push(`  ${m.from} -> Garnet ${label}: ${m.entries.length} entries; ${m.fitCount} fit the ${m.cap}-char cap (most recent kept)`);
    if (m.fitCount < m.entries.length) {
      L.push(`    ${m.entries.length - m.fitCount} older entries will not fit; the full file is archived (see below). Curate with \`garnet memory edit ${m.file}\`.`);
      L.push(`    All of it needs about ${m.needed} chars${m.needed > 20_000 ? ' (more than the 20,000 maximum)' : ''}: --raise-caps raises the cap${m.needed > 20_000 ? ' to 20,000' : ''}.`);
    }
    if (m.shortened) L.push(`    ${m.shortened} entries are over 500 chars and will be shortened.`);
    for (const s of m.skipped) L.push(`    skipped "${s.text}": ${s.reason}`);
  }

  L.push('', 'Persona');
  if (!plan.persona) L.push('  nothing found');
  else {
    L.push(`  ${plan.persona.from.join(' + ')} -> config persona (${plan.persona.text.length}/4000 chars${plan.persona.truncated ? ', TRUNCATED; originals archived' : ''})`);
    if (plan.name) L.push(`  Assistant name: ${plan.name} (Garnet will introduce itself by this name)`);
    L.push('  Merged into a persona that only has `garnet setup` basics; any other existing persona is kept unless you pass --persona merge|replace.');
  }

  L.push('', 'Skills');
  if (!plan.skills.length) L.push('  none found');
  for (const s of plan.skills) {
    const rename = s.name && s.name !== s.originalName ? ` (renamed from "${s.originalName}")` : '';
    if (s.conflict) {
      L.push(`  SKIP ${s.name || s.originalName}: ${s.conflict}`);
      continue;
    }
    const tags = [
      s.extraFiles.length ? `+${s.extraFiles.length} supporting files archived` : '',
      s.baseDirRewrite ? `paths point at ${s.baseDirRewrite}/` : '',
      s.bodyTruncated ? 'body truncated' : '',
      s.editedBundled ? 'bundled skill you edited' : '',
    ].filter(Boolean);
    L.push(`  ${s.name}${rename}: ${one(s.description)}${tags.length ? ` [${tags.join('; ')}]` : ''}`);
    if (s.missing.length) L.push(`    needs: ${s.missing.join('; ')}`);
  }
  if (plan.skills.length) L.push('  Skills that already exist in Garnet are left untouched.');

  L.push('', 'Jobs (added DISABLED: review, then set "enabled": true in config.json)');
  if (!plan.jobs.length) L.push('  none found');
  for (const j of plan.jobs) {
    if (!j.job) {
      L.push(`  SKIP "${j.from}": ${j.notes.join('; ')}`);
      continue;
    }
    const when = j.job.kind === 'cron' ? `cron "${j.job.cron}"${j.job.timezone ? ` ${j.job.timezone}` : ''}` : `every ${j.job.everyMinutes} min`;
    const to = j.job.notify ? `-> ${j.job.notify.channel} ${j.job.notify.chatId}` : '-> run history only';
    L.push(`  ${j.job.id} ("${j.from}"): ${when} ${to}`);
    if (j.notes.length) L.push(`    ${j.notes.join('; ')}`);
  }

  if (plan.pairings.length) {
    L.push('', 'Allowlisted senders (paired only with --pairings; each becomes an owner who can approve actions)');
    for (const p of plan.pairings) L.push(`  ${p.channel} ${p.senderId}${p.displayName ? ` (${p.displayName})` : ''}: ${p.from}`);
  }

  L.push('', `Archived copies under <workspace>/imported/${plan.source}/ (${plan.copies.length})`);
  for (const c of plan.copies.slice(0, 40)) L.push(`  ${c.dest.replace(`imported/${plan.source}/`, '')}: ${c.reason}`);
  if (plan.copies.length > 40) L.push(`  ... and ${plan.copies.length - 40} more`);

  L.push('', 'Not imported');
  if (!plan.notImported.length) L.push('  nothing notable');
  for (const n of plan.notImported) L.push(`  ${n.what}: ${n.why}`);
  if (plan.envVars.length) {
    L.push('', 'Environment variables you may need (names only; set the values yourself with `garnet secrets set <NAME>`):');
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
  for (const m of r.memory) {
    L.push(`  ${m.file}: ${m.added} added, ${m.alreadyPresent} already present, ${m.omittedForCap} left out for the cap (${m.used}/${m.limit} chars)`);
    if (m.raisedFrom !== undefined) L.push(`    cap raised from ${m.raisedFrom} to ${m.limit} (memory.${m.file === 'memory' ? 'memoryChars' : 'userChars'})`);
  }
  L.push(`  persona: ${r.persona}${r.personaNote ? ` (${r.personaNote})` : ''}`);
  for (const s of r.skills) L.push(`  skill ${s.name}: ${s.status}${s.detail ? ` (${s.detail})` : ''}`);
  for (const j of r.jobs) L.push(`  job ${j.id}: ${j.status === 'added' ? 'added (disabled)' : j.status}${j.detail ? ` (${j.detail})` : ''}`);
  const requested = r.pairings.filter((p) => p.status !== 'not-requested');
  for (const p of requested) L.push(`  paired ${p.channel} ${p.senderId}: ${p.status === 'added' ? 'added' : 'already paired'}`);
  const skipped = r.pairings.length - requested.length;
  if (skipped) L.push(`  pairings: ${skipped} allowlisted sender(s) not paired (re-run with --pairings, or \`garnet pair add <channel> <id>\`)`);
  const by = (st: string) => r.copied.filter((c) => c.status === st).length;
  L.push(`  files: ${by('copied')} copied, ${by('exists')} already there, ${by('failed')} failed`);
  for (const c of r.copied.filter((x) => x.status === 'failed')) L.push(`    ${c.dest}: ${c.detail}`);
  if (r.jobs.some((j) => j.status === 'added')) L.push('  Imported jobs are disabled. Check each with `garnet jobs list`, then enable it in config.json and restart Garnet.');
  return `${L.join('\n')}\n`;
}
