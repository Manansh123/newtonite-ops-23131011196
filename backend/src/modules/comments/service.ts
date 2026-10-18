import { prisma, Tx } from '../../lib/prisma';
import { notFound } from '../../lib/errors';
import { isUuid } from '../../lib/uuid';
import { assertCan, type AuthUser } from '../../policy/permissions';
import { recordEvent } from '../activity/activity';

async function loadCtx(tx: Tx | typeof prisma, itemId: string) {
  if (!isUuid(itemId)) throw notFound('Work item not found');
  const item = await tx.workItem.findUnique({
    where: { id: itemId },
    select: { id: true, teamId: true, assigneeId: true, createdById: true },
  });
  if (!item) throw notFound('Work item not found');
  return item;
}

const toDto = (c: { id: string; body: string; createdAt: Date; author: { id: string; name: string } }) => ({
  id: c.id,
  body: c.body,
  author: c.author,
  createdAt: c.createdAt,
});

export async function listComments(user: AuthUser, itemId: string) {
  const item = await loadCtx(prisma, itemId);
  assertCan(user, 'item.read', item);
  const rows = await prisma.comment.findMany({
    where: { itemId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 500,
    include: { author: { select: { id: true, name: true } } },
  });
  return rows.map(toDto);
}

export async function addComment(tx: Tx, user: AuthUser, itemId: string, body: string) {
  const item = await loadCtx(tx, itemId);
  assertCan(user, 'item.comment', item);
  const comment = await tx.comment.create({
    data: { itemId, authorId: user.id, body },
    include: { author: { select: { id: true, name: true } } },
  });
  await recordEvent(tx, { itemId, actorId: user.id, type: 'COMMENT_ADDED', to: body.slice(0, 500) });
  return toDto(comment);
}
