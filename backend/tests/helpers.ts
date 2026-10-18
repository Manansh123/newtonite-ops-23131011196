import request from 'supertest';
import type { Role } from '@prisma/client';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { signToken } from '../src/middleware/auth';

export const app = createApp();
export const api = () => request(app);

export async function resetDb() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE comments, activity_events, idempotency_keys, work_items, memberships, users, teams RESTART IDENTITY CASCADE',
  );
}

export interface Actor {
  id: string;
  name: string;
  token: string;
}

let counter = 0;
export async function makeUser(name: string, memberships: [teamId: string, role: Role][]): Promise<Actor> {
  const user = await prisma.user.create({
    data: {
      email: `${name.toLowerCase()}${++counter}@test.local`,
      name,
      passwordHash: 'x',
      memberships: { create: memberships.map(([teamId, role]) => ({ teamId, role })) },
    },
  });
  return { id: user.id, name, token: signToken(user.id) };
}

/**
 * Two teams, several users:
 *   Team A: alice=LEAD, bob=MEMBER, carol=MEMBER, dave=VIEWER
 *   Team B: erin=LEAD, frank=MEMBER
 *   grace = MEMBER in A and LEAD in B   (roles are per team)
 */
export async function makeWorld() {
  const teamA = await prisma.team.create({ data: { name: 'Team A' } });
  const teamB = await prisma.team.create({ data: { name: 'Team B' } });
  const alice = await makeUser('Alice', [[teamA.id, 'LEAD']]);
  const bob = await makeUser('Bob', [[teamA.id, 'MEMBER']]);
  const carol = await makeUser('Carol', [[teamA.id, 'MEMBER']]);
  const dave = await makeUser('Dave', [[teamA.id, 'VIEWER']]);
  const erin = await makeUser('Erin', [[teamB.id, 'LEAD']]);
  const frank = await makeUser('Frank', [[teamB.id, 'MEMBER']]);
  const grace = await makeUser('Grace', [[teamA.id, 'MEMBER'], [teamB.id, 'LEAD']]);
  return { teamA, teamB, alice, bob, carol, dave, erin, frank, grace };
}

export const auth = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

let keyCounter = 0;
export const newKey = () => `key-${Date.now()}-${++keyCounter}`;

/** Create an item through the real API (so version/activity are real). */
export async function createItemVia(actor: Actor, teamId: string, overrides: Record<string, unknown> = {}) {
  const res = await api()
    .post('/api/items')
    .set(auth(actor))
    .set('Idempotency-Key', newKey())
    .send({ title: 'Test item', type: 'TASK', teamId, ...overrides });
  if (res.status !== 201) throw new Error(`createItemVia failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; version: number; status: string };
}

export const claim = (actor: Actor, id: string) => api().post(`/api/items/${id}/claim`).set(auth(actor));

export const transition = (actor: Actor, id: string, to: string, version: number) =>
  api().post(`/api/items/${id}/transition`).set(auth(actor)).send({ to, version });

export const dbItem = (id: string) => prisma.workItem.findUniqueOrThrow({ where: { id } });
export const dbEvents = (id: string) => prisma.activityEvent.findMany({ where: { itemId: id }, orderBy: { seq: 'asc' } });

export { prisma };

/**
 * Deterministic race injection. Wraps a transaction client so that, just before the first
 * `workItem.updateMany` runs, `rival()` executes and COMMITS on a separate connection.
 * This reproduces "someone else's write lands between my read and my write" exactly,
 * which is the case the version/conditional UPDATE guard exists for.
 */
export function withRivalWriteBeforeUpdate<T extends object>(tx: T, rival: () => Promise<unknown>): T {
  let fired = false;
  return new Proxy(tx, {
    get(target, prop) {
      const value = (target as any)[prop];
      if (prop !== 'workItem') return typeof value === 'function' ? value.bind(target) : value;
      return new Proxy(value, {
        get(delegate, method) {
          const fn = (delegate as any)[method];
          if (method !== 'updateMany') return typeof fn === 'function' ? fn.bind(delegate) : fn;
          return async (args: unknown) => {
            if (!fired) {
              fired = true;
              await rival();
            }
            return fn.call(delegate, args);
          };
        },
      });
    },
  }) as T;
}
