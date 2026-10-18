import type { ItemStatus, Prisma } from '@prisma/client';
import { can, type AuthUser } from '../../policy/permissions';
import { nextStatuses, preconditionError, TRANSITIONS } from '../../policy/workflow';

export const itemInclude = {
  team: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.WorkItemInclude;

export type ItemRow = Prisma.WorkItemGetPayload<{ include: typeof itemInclude }>;

export function toItemDto(row: ItemRow) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    type: row.type,
    priority: row.priority,
    status: row.status,
    team: row.team,
    assignee: row.assignee,
    createdBy: row.createdBy,
    dueDate: row.dueDate,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Detail view = item + what THIS user may do with it. The booleans come from the same
 * policy functions the endpoints enforce, so the UI never duplicates permission logic.
 * They are hints for rendering buttons only; every action is re-checked on the server.
 */
export function toDetailDto(row: ItemRow, user: AuthUser) {
  const ctx = { teamId: row.teamId, assigneeId: row.assigneeId, createdById: row.createdById };
  const transitions: ItemStatus[] = nextStatuses(row.status).filter(
    (to) => can(user, TRANSITIONS[row.status][to]!, ctx) && preconditionError(row, to) === null,
  );
  return {
    ...toItemDto(row),
    allowed: {
      edit: can(user, 'item.edit', ctx),
      comment: can(user, 'item.comment', ctx),
      claim: can(user, 'item.claim', ctx) && row.assigneeId === null && row.status === 'OPEN',
      transitions,
    },
  };
}
