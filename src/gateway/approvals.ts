import { createHash, randomInt } from 'node:crypto';
import type { Approver } from '../policy/index.ts';
import type { ApprovalStore } from '../store/index.ts';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function operationHash(tool: string, input: unknown): string {
  return createHash('sha256').update(`${tool}\n${stableJson(input)}`).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Approver for unattended surfaces (chat, API, schedules). An `ask` operation
 * is first checked against single-use grants for that exact operation in that
 * session; otherwise it is persisted as a pending approval with a short code
 * and the task pauses. Approving grants exactly that operation once, so a
 * model that changes the arguments has to ask again.
 */
export function persistentApprover(store: ApprovalStore, ttlMinutes = 24 * 60): Approver {
  return async (req) => {
    const hash = operationHash(req.tool, req.input);
    if (store.consumeGrant(req.sessionId, req.tool, hash)) return 'approved';
    // Codes are kept forever (they are the audit trail), so skip any already used.
    let code: string;
    do code = Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    while (store.get(code));
    store.create({
      code,
      sessionId: req.sessionId,
      callId: req.callId,
      tool: req.tool,
      capability: req.capability,
      summary: req.summary,
      inputHash: hash,
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
    });
    return 'deferred';
  };
}
