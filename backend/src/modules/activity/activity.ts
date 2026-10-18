import type { ActivityType } from '@prisma/client';
import { prisma, Tx } from '../../lib/prisma';
import type { AuthUser } from '../../policy/permissions';
import { assertCan } from '../../policy/permissions';
import { notFound } from '../../lib/errors';
import { isUuid } from '../../lib/uuid';

/**
 * Appends one event. ALWAYS call this with the same `tx` that updates the item, so the item
 * change and its history commit (or roll back) together. The table is also append-only at
 * the database level (trigger in 0001_init.sql).
 */
export async function recordEvent(
  tx: Tx,
  e: { itemId: string; actorId: string; type: ActivityType; from?: string | null; to?: string | null },
) {
  await tx.activityEvent.create({
    data: { itemId: e.itemId, actorId: e.actorId, type: e.type, fromValue: e.from ?? null, toValue: e.to ?? null },
  });
}

export async function listActivity(user: AuthUser, itemId: string) {
  if (!isUuid(itemId)) throw notFound('Work item not found');
  const item = await prisma.workItem.findUnique({
    where: { id: itemId },
    select: { teamId: true, assigneeId: true, createdById: true },
  });
  if (!item) throw notFound('Work item not found');
  assertCan(user, 'item.read', item);

  const events = await prisma.activityEvent.findMany({
    where: { itemId },
    orderBy: { seq: 'asc' },
    take: 500,
    include: { actor: { select: { id: true, name: true } } },
  });
  return events.map((e) => ({
    id: e.id,
    type: e.type,
    from: e.fromValue,
    to: e.toValue,
    actor: e.actor,
    createdAt: e.createdAt,
  }));
}
