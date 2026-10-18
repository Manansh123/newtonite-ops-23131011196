import type { Request } from 'express';
import { prisma, Tx } from '../../lib/prisma';
import { badRequest, conflict, unprocessable } from '../../lib/errors';
import { sha256, stableStringify } from '../../lib/hash';

export interface Outcome {
  status: number;
  body: unknown;
}

/**
 * Runs `work` inside ONE database transaction. If the request carries an Idempotency-Key:
 *
 *   1. INSERT the key row with ON CONFLICT DO NOTHING (key is scoped per user).
 *      - If a concurrent request with the same key is still in flight, Postgres makes this
 *        INSERT wait on the unique index until that transaction commits or rolls back. So two
 *        parallel duplicates can never both run `work`.
 *   2. Inserted -> run `work`, then store the response on the key row. Key + item + activity
 *      event commit atomically; the key exists if and only if the work happened.
 *   3. Conflict -> the original request already committed: return its stored response
 *      (or 422 if the same key is reused for a different request).
 *
 * Failed requests roll everything back (including the key row), so a failed request can be retried.
 */
export async function runIdempotent(
  req: Request,
  userId: string,
  opts: { required: boolean },
  work: (tx: Tx) => Promise<Outcome>,
): Promise<Outcome & { replayed: boolean }> {
  const key = req.header('Idempotency-Key');

  if (!key) {
    if (opts.required) throw badRequest('Idempotency-Key header is required for this request');
    const out = await prisma.$transaction(async (tx) => finalize(await work(tx)));
    return { ...out, replayed: false };
  }
  if (key.length > 200) throw badRequest('Idempotency-Key must be at most 200 characters');

  const requestHash = sha256(`${req.method} ${req.baseUrl}${req.path}\n${stableStringify(req.body ?? {})}`);

  return prisma.$transaction(async (tx) => {
    const inserted = await tx.$executeRaw`
      INSERT INTO idempotency_keys (user_id, key, request_hash)
      VALUES (${userId}::uuid, ${key}, ${requestHash})
      ON CONFLICT (user_id, key) DO NOTHING`;

    if (inserted === 0) {
      const stored = await tx.idempotencyKey.findUniqueOrThrow({ where: { userId_key: { userId, key } } });
      if (stored.requestHash !== requestHash) {
        throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
      }
      if (stored.responseStatus === null) {
        throw conflict('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed');
      }
      return { status: stored.responseStatus, body: stored.responseBody, replayed: true };
    }

    const out = finalize(await work(tx));
    await tx.idempotencyKey.update({
      where: { userId_key: { userId, key } },
      data: { responseStatus: out.status, responseBody: out.body as object },
    });
    return { ...out, replayed: false };
  });
}

/** Round-trip through JSON so the first response and every replay are byte-identical. */
const finalize = (o: Outcome): Outcome => ({ status: o.status, body: JSON.parse(JSON.stringify(o.body)) });
