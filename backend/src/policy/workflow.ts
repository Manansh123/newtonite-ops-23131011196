import { ItemStatus } from '@prisma/client';
import type { Action } from './permissions';

/**
 * The state machine. This map is the single source of truth for which transitions exist
 * and which permission each one requires. To add a status or a transition, edit only this file
 * (plus the enum in the schema/migration).
 *
 *   OPEN -> IN_PROGRESS -> AWAITING_APPROVAL -> RESOLVED -> CLOSED
 *                 ^______________|  (rejected)
 */
export const TRANSITIONS: Record<ItemStatus, Partial<Record<ItemStatus, Action>>> = {
  OPEN: { IN_PROGRESS: 'transition.start' },
  IN_PROGRESS: { AWAITING_APPROVAL: 'transition.submit' },
  AWAITING_APPROVAL: { RESOLVED: 'transition.approve', IN_PROGRESS: 'transition.reject' },
  RESOLVED: { CLOSED: 'transition.close' },
  CLOSED: {},
};

export const transitionAction = (from: ItemStatus, to: ItemStatus): Action | null => TRANSITIONS[from][to] ?? null;

export const nextStatuses = (from: ItemStatus): ItemStatus[] => Object.keys(TRANSITIONS[from]) as ItemStatus[];

/** Statuses that count as finished work (excluded from the "needs attention" dashboard views). */
export const FINISHED: ItemStatus[] = ['RESOLVED', 'CLOSED'];

/**
 * Business preconditions that are not about permissions. Returns a message if the transition
 * cannot happen yet. (An item can only leave OPEN once someone owns it.)
 */
export function preconditionError(item: { status: ItemStatus; assigneeId: string | null }, to: ItemStatus): string | null {
  if (item.status === 'OPEN' && to === 'IN_PROGRESS' && item.assigneeId === null) {
    return 'Claim the item before starting it';
  }
  return null;
}
