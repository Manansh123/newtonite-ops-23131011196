import { Role } from '@prisma/client';
import { forbidden, notFound } from '../lib/errors';

/**
 * THE authorization module. Every endpoint calls `assertCan` (or `can` for UI hints);
 * nothing else in the codebase decides who may do what.
 *
 * Roles are per team (memberships table). Rank: VIEWER < MEMBER < LEAD < ADMIN.
 */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  memberships: Map<string, Role>; // teamId -> role
}

/** The facts about an item that permission rules need. */
export interface ItemCtx {
  teamId: string;
  assigneeId: string | null;
  createdById: string;
}

export type Action =
  | 'item.read'
  | 'item.comment'
  | 'item.create'
  | 'item.claim'
  | 'item.edit'
  | 'transition.start' //   OPEN -> IN_PROGRESS
  | 'transition.submit' //  IN_PROGRESS -> AWAITING_APPROVAL
  | 'transition.approve' // AWAITING_APPROVAL -> RESOLVED   (the approval step)
  | 'transition.reject' //  AWAITING_APPROVAL -> IN_PROGRESS
  | 'transition.close'; //  RESOLVED -> CLOSED

const RANK: Record<Role, number> = { VIEWER: 0, MEMBER: 1, LEAD: 2, ADMIN: 3 };
const atLeast = (r: Role, min: Role) => RANK[r] >= RANK[min];

type Rule = (role: Role, user: AuthUser, item: ItemCtx) => boolean;

const isOwnerOf: Rule = (_r, user, item) => item.assigneeId === user.id;
const isCreatorOrAssignee: Rule = (_r, user, item) => item.createdById === user.id || item.assigneeId === user.id;

// Role x action matrix. Keep in sync with README / ENGINEERING_DECISIONS.
const RULES: Record<Action, Rule> = {
  'item.read': () => true, //                                     any member of the item's team
  'item.comment': (r) => atLeast(r, 'MEMBER'),
  'item.create': (r) => atLeast(r, 'MEMBER'),
  'item.claim': (r) => atLeast(r, 'MEMBER'),
  'item.edit': (r, u, i) => atLeast(r, 'LEAD') || (atLeast(r, 'MEMBER') && isCreatorOrAssignee(r, u, i)),
  'transition.start': (r, u, i) => atLeast(r, 'LEAD') || (atLeast(r, 'MEMBER') && isOwnerOf(r, u, i)),
  'transition.submit': (r, u, i) => atLeast(r, 'LEAD') || (atLeast(r, 'MEMBER') && isOwnerOf(r, u, i)),
  'transition.approve': (r) => atLeast(r, 'LEAD'),
  'transition.reject': (r) => atLeast(r, 'LEAD'),
  'transition.close': (r) => atLeast(r, 'LEAD'),
};

export const roleIn = (user: AuthUser, teamId: string): Role | null => user.memberships.get(teamId) ?? null;

/** Teams in which the user holds at least `min`. Used to scope list queries. */
export function teamIdsWithRole(user: AuthUser, min: Role): string[] {
  return [...user.memberships.entries()].filter(([, r]) => atLeast(r, min)).map(([t]) => t);
}

/** Boolean form, used to tell the UI which buttons to render. The server still enforces. */
export function can(user: AuthUser, action: Action, item: ItemCtx): boolean {
  const role = roleIn(user, item.teamId);
  return role !== null && RULES[action](role, user, item);
}

/**
 * Throws 404 if the user is not in the item's team (don't reveal the item exists),
 * 403 if they are in the team but their role does not allow the action.
 */
export function assertCan(user: AuthUser, action: Action, item: ItemCtx): void {
  const role = roleIn(user, item.teamId);
  if (role === null) throw notFound('Work item not found');
  if (!RULES[action](role, user, item)) throw forbidden(`Your role does not allow: ${action}`);
}

/** Creating has no item yet, so it is checked against the target team. */
export function assertCanCreateIn(user: AuthUser, teamId: string): void {
  const role = roleIn(user, teamId);
  if (role === null) throw forbidden('You are not a member of that team');
  if (!RULES['item.create'](role, user, { teamId, assigneeId: null, createdById: user.id })) {
    throw forbidden('Your role does not allow creating items in this team');
  }
}
