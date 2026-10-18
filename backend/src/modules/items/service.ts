import type { Prisma } from '@prisma/client';
import { prisma, Tx } from '../../lib/prisma';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { decodeCursor, encodeCursor } from '../../lib/cursor';
import { isUuid } from '../../lib/uuid';
import { assertCan, assertCanCreateIn, teamIdsWithRole, type AuthUser } from '../../policy/permissions';
import { FINISHED, preconditionError, transitionAction } from '../../policy/workflow';
import { recordEvent } from '../activity/activity';
import { itemInclude, toDetailDto, toItemDto, type ItemRow } from './serializer';
import type { CreateItemInput, ListQuery, UpdateItemInput } from './schemas';
import type { ItemStatus } from '@prisma/client';

const ctxOf = (i: { teamId: string; assigneeId: string | null; createdById: string }) => ({
  teamId: i.teamId,
  assigneeId: i.assigneeId,
  createdById: i.createdById,
});

/** Load an item for a mutation. 404 for malformed ids / missing rows; team check happens in assertCan. */
async function loadItem(tx: Tx | typeof prisma, id: string): Promise<ItemRow> {
  if (!isUuid(id)) throw notFound('Work item not found');
  const item = await tx.workItem.findUnique({ where: { id }, include: itemInclude });
  if (!item) throw notFound('Work item not found');
  return item;
}

/** 409 carrying the item as it is NOW, so the client can show/refetch the latest state. */
async function conflictWithLatest(tx: Tx, user: AuthUser, id: string, code: string, message: string) {
  const latest = await loadItem(tx, id);
  return conflict(code, message, toDetailDto(latest, user));
}

// ---------------------------------------------------------------- reads

export async function getItem(user: AuthUser, id: string) {
  const item = await loadItem(prisma, id);
  assertCan(user, 'item.read', ctxOf(item)); // 404 if not in the item's team
  return toDetailDto(item, user);
}

export async function listItems(user: AuthUser, q: ListQuery) {
  // Resource-level scoping: the query itself can only ever see the caller's teams.
  const memberTeamIds = [...user.memberships.keys()];
  const and: Prisma.WorkItemWhereInput[] = [{ teamId: { in: memberTeamIds } }];

  if (q.teamId) and.push({ teamId: q.teamId });
  if (q.status) and.push({ status: q.status });
  if (q.priority) and.push({ priority: q.priority });
  if (q.type) and.push({ type: q.type });
  if (q.assignee === 'me') and.push({ assigneeId: user.id });
  else if (q.assignee === 'unassigned') and.push({ assigneeId: null });
  else if (q.assignee) and.push({ assigneeId: q.assignee });

  if (q.q) {
    and.push({
      OR: [
        { title: { contains: q.q, mode: 'insensitive' } },
        { description: { contains: q.q, mode: 'insensitive' } },
      ],
    });
  }

  // The three dashboard views are just pre-set server-side filters.
  if (q.view === 'assigned_to_me') {
    and.push({ assigneeId: user.id, status: { notIn: FINISHED } });
  } else if (q.view === 'unassigned_urgent') {
    and.push({ assigneeId: null, priority: 'URGENT', status: { notIn: FINISHED } });
  } else if (q.view === 'awaiting_my_approval') {
    // Items the user is allowed to approve: AWAITING_APPROVAL in teams where they are Lead+.
    and.push({ status: 'AWAITING_APPROVAL', teamId: { in: teamIdsWithRole(user, 'LEAD') } });
  }

  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    and.push({ OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] });
  }

  const rows = await prisma.workItem.findMany({
    where: { AND: and },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: q.limit + 1, // one extra row tells us whether there is a next page
    include: itemInclude,
  });

  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toItemDto),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

// ---------------------------------------------------------------- writes (all take the caller's tx)

export async function createItem(tx: Tx, user: AuthUser, input: CreateItemInput) {
  assertCanCreateIn(user, input.teamId);
  const item = await tx.workItem.create({
    data: {
      title: input.title,
      description: input.description,
      type: input.type,
      priority: input.priority,
      teamId: input.teamId,
      dueDate: input.dueDate ?? null,
      createdById: user.id,
    },
    include: itemInclude,
  });
  await recordEvent(tx, { itemId: item.id, actorId: user.id, type: 'CREATED', to: item.status });
  return toDetailDto(item, user);
}

export async function updateItem(tx: Tx, user: AuthUser, id: string, input: UpdateItemInput) {
  const item = await loadItem(tx, id);
  assertCan(user, 'item.edit', ctxOf(item));

  // Fast-path rejection. The real guard is the `version` condition in the UPDATE below,
  // which is what protects against a write that sneaks in between this read and that write.
  if (item.version !== input.version) {
    throw await conflictWithLatest(tx, user, id, 'VERSION_CONFLICT', 'This item was changed by someone else');
  }

  const changed: Prisma.WorkItemUncheckedUpdateManyInput = {};
  const changedFields: string[] = [];
  if (input.title !== undefined && input.title !== item.title) (changed.title = input.title), changedFields.push('title');
  if (input.description !== undefined && input.description !== item.description) {
    changed.description = input.description;
    changedFields.push('description');
  }
  if (input.type !== undefined && input.type !== item.type) (changed.type = input.type), changedFields.push('type');
  if (input.dueDate !== undefined && (input.dueDate?.getTime() ?? null) !== (item.dueDate?.getTime() ?? null)) {
    changed.dueDate = input.dueDate;
    changedFields.push('dueDate');
  }
  const priorityChanged = input.priority !== undefined && input.priority !== item.priority;
  if (priorityChanged) changed.priority = input.priority;

  if (changedFields.length === 0 && !priorityChanged) return toDetailDto(item, user); // nothing to do

  const res = await tx.workItem.updateMany({
    where: { id, version: input.version }, // optimistic lock
    data: { ...changed, version: { increment: 1 }, updatedAt: new Date() },
  });
  if (res.count === 0) {
    throw await conflictWithLatest(tx, user, id, 'VERSION_CONFLICT', 'This item was changed by someone else');
  }

  if (priorityChanged) {
    await recordEvent(tx, { itemId: id, actorId: user.id, type: 'PRIORITY_CHANGED', from: item.priority, to: input.priority });
  }
  if (changedFields.length) {
    await recordEvent(tx, { itemId: id, actorId: user.id, type: 'FIELDS_UPDATED', to: changedFields.join(', ') });
  }
  return toDetailDto(await loadItem(tx, id), user);
}

export async function claimItem(tx: Tx, user: AuthUser, id: string) {
  const item = await loadItem(tx, id);
  assertCan(user, 'item.claim', ctxOf(item));

  // Atomic compare-and-set. If two users race, Postgres serialises the two UPDATEs on the row
  // lock; the loser re-evaluates the WHERE clause against the winner's committed row and matches 0 rows.
  const res = await tx.workItem.updateMany({
    where: { id, assigneeId: null, status: 'OPEN' },
    data: { assigneeId: user.id, status: 'IN_PROGRESS', version: { increment: 1 }, updatedAt: new Date() },
  });
  if (res.count === 0) {
    throw await conflictWithLatest(tx, user, id, 'ALREADY_CLAIMED', 'This item has already been claimed');
  }

  await recordEvent(tx, { itemId: id, actorId: user.id, type: 'ASSIGNED', from: null, to: user.name });
  await recordEvent(tx, { itemId: id, actorId: user.id, type: 'STATUS_CHANGED', from: 'OPEN', to: 'IN_PROGRESS' });
  return toDetailDto(await loadItem(tx, id), user);
}

export async function transitionItem(tx: Tx, user: AuthUser, id: string, to: ItemStatus, version: number) {
  const item = await loadItem(tx, id);
  assertCan(user, 'item.read', ctxOf(item)); // 404 if not in the item's team

  if (item.version !== version) {
    throw await conflictWithLatest(tx, user, id, 'VERSION_CONFLICT', 'This item was changed by someone else');
  }

  // 1. Is this transition part of the workflow at all?
  const action = transitionAction(item.status, to);
  if (!action) {
    throw unprocessable('INVALID_TRANSITION', `Cannot move an item from ${item.status} to ${to}`);
  }
  // 2. Is THIS user allowed to perform it? (approval = Lead+ of the item's team)
  assertCan(user, action, ctxOf(item));
  // 3. Business precondition (e.g. must be claimed before starting)
  const blocked = preconditionError(item, to);
  if (blocked) throw unprocessable('PRECONDITION_FAILED', blocked);

  const res = await tx.workItem.updateMany({
    where: { id, version },
    data: { status: to, version: { increment: 1 }, updatedAt: new Date() },
  });
  if (res.count === 0) {
    throw await conflictWithLatest(tx, user, id, 'VERSION_CONFLICT', 'This item was changed by someone else');
  }

  await recordEvent(tx, { itemId: id, actorId: user.id, type: 'STATUS_CHANGED', from: item.status, to });
  return toDetailDto(await loadItem(tx, id), user);
}
