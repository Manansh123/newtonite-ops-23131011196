import { updateItem, transitionItem } from '../src/modules/items/service';
import type { AuthUser } from '../src/policy/permissions';
import { api, auth, claim, createItemVia, dbEvents, dbItem, makeWorld, prisma, resetDb, transition, withRivalWriteBeforeUpdate } from './helpers';

// Critical behaviour B: optimistic locking with `version`.
describe('stale update (optimistic locking)', () => {
  let w: Awaited<ReturnType<typeof makeWorld>>;
  beforeEach(async () => {
    await resetDb();
    w = await makeWorld();
  });
  afterAll(() => prisma.$disconnect());

  const patch = (actor: typeof w.alice, id: string, body: Record<string, unknown>) =>
    api().patch(`/api/items/${id}`).set(auth(actor)).send(body);

  it('an update with an old version is rejected with 409 and does NOT overwrite newer data', async () => {
    const item = await createItemVia(w.bob, w.teamA.id, { title: 'Original' });
    expect(item.version).toBe(1);

    // Alice (lead) updates first -> version 2
    const first = await patch(w.alice, item.id, { version: 1, title: 'Alice was here' });
    expect(first.status).toBe(200);
    expect(first.body.version).toBe(2);

    // Bob still holds version 1 -> must be rejected
    const stale = await patch(w.bob, item.id, { version: 1, title: 'Bob overwrites?' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.latest.title).toBe('Alice was here'); // 409 carries the latest item
    expect(stale.body.latest.version).toBe(2);

    // data unchanged, no extra history
    const row = await dbItem(item.id);
    expect(row.title).toBe('Alice was here');
    expect(row.version).toBe(2);
    expect((await dbEvents(item.id)).filter((e) => e.type === 'FIELDS_UPDATED')).toHaveLength(1);
  });

  it('after reloading and retrying with the latest version, the update succeeds', async () => {
    const item = await createItemVia(w.bob, w.teamA.id);
    await patch(w.alice, item.id, { version: 1, title: 'Alice' });
    const stale = await patch(w.bob, item.id, { version: 1, description: 'Bob notes' });
    const retry = await patch(w.bob, item.id, { version: stale.body.latest.version, description: 'Bob notes' });
    expect(retry.status).toBe(200);
    expect(retry.body.version).toBe(3);
    expect(retry.body.title).toBe('Alice'); // Alice's change preserved
    expect(retry.body.description).toBe('Bob notes');
  });

  it('two simultaneous updates with the same version: exactly one wins', async () => {
    const item = await createItemVia(w.bob, w.teamA.id);
    const [r1, r2] = await Promise.all([
      patch(w.alice, item.id, { version: 1, title: 'From Alice' }),
      patch(w.bob, item.id, { version: 1, title: 'From Bob' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const row = await dbItem(item.id);
    expect(row.version).toBe(2);
    expect(row.title).toBe(r1.status === 200 ? 'From Alice' : 'From Bob');
  });

  it('a stale status transition is rejected too', async () => {
    const item = await createItemVia(w.bob, w.teamA.id);
    await claim(w.bob, item.id); // version 1 -> 2
    const res = await transition(w.bob, item.id, 'AWAITING_APPROVAL', 1); // stale
    expect(res.status).toBe(409);
    expect((await dbItem(item.id)).status).toBe('IN_PROGRESS');
  });

  it('version is required on update (400 without it)', async () => {
    const item = await createItemVia(w.bob, w.teamA.id);
    const res = await patch(w.bob, item.id, { title: 'no version' });
    expect(res.status).toBe(400);
  });

  it('a priority change bumps version and writes a PRIORITY_CHANGED event with from/to', async () => {
    const item = await createItemVia(w.bob, w.teamA.id, { priority: 'LOW' });
    const res = await patch(w.alice, item.id, { version: 1, priority: 'URGENT' });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    const ev = (await dbEvents(item.id)).find((e) => e.type === 'PRIORITY_CHANGED');
    expect(ev).toMatchObject({ fromValue: 'LOW', toValue: 'URGENT', actorId: w.alice.id });
  });

  it('clients cannot set status / assignee / version through PATCH (strict body)', async () => {
    const item = await createItemVia(w.bob, w.teamA.id);
    const res = await patch(w.bob, item.id, { version: 1, status: 'CLOSED', assigneeId: w.bob.id });
    expect(res.status).toBe(400);
    expect((await dbItem(item.id)).status).toBe('OPEN');
  });

  // The early `item.version !== input.version` check can be passed by two requests at once.
  // These tests force a rival write to commit AFTER that check but BEFORE our UPDATE, proving
  // that the UPDATE statement ITSELF refuses to overwrite (`WHERE version = ?`).
  describe('the UPDATE statement is itself guarded (not just the early check)', () => {
    const asUser = (a: { id: string; name: string }, teamId: string, role: 'MEMBER' | 'LEAD'): AuthUser => ({
      id: a.id, name: a.name, email: '', memberships: new Map([[teamId, role]]),
    });

    it('edit: a write landing between read and write is not overwritten', async () => {
      const item = await createItemVia(w.bob, w.teamA.id, { title: 'Original' });
      const bob = asUser(w.bob, w.teamA.id, 'MEMBER');

      const attempt = prisma.$transaction((tx) =>
        updateItem(
          withRivalWriteBeforeUpdate(tx, () => prisma.workItem.update({ where: { id: item.id }, data: { title: 'Rival', version: { increment: 1 } } })),
          bob, item.id, { version: 1, title: 'Mine' },
        ),
      );

      await expect(attempt).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
      const row = await dbItem(item.id);
      expect(row.title).toBe('Rival'); // newer data survived
      expect(row.version).toBe(2);
      expect((await dbEvents(item.id)).filter((e) => e.type === 'FIELDS_UPDATED')).toHaveLength(0);
    });

    it('transition: a write landing between read and write is not overwritten', async () => {
      const item = await createItemVia(w.bob, w.teamA.id);
      await claim(w.bob, item.id); // v2, IN_PROGRESS
      const bob = asUser(w.bob, w.teamA.id, 'MEMBER');

      const attempt = prisma.$transaction((tx) =>
        transitionItem(
          withRivalWriteBeforeUpdate(tx, () => prisma.workItem.update({ where: { id: item.id }, data: { priority: 'URGENT', version: { increment: 1 } } })),
          bob, item.id, 'AWAITING_APPROVAL', 2,
        ),
      );

      await expect(attempt).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
      const row = await dbItem(item.id);
      expect(row.status).toBe('IN_PROGRESS'); // our transition did not apply
      expect(row.priority).toBe('URGENT');
      expect(row.version).toBe(3);
    });
  });
});
