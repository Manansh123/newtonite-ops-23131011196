import { api, auth, claim, createItemVia, dbEvents, dbItem, makeWorld, prisma, resetDb, transition } from './helpers';

// Critical behaviour D: server-enforced workflow; only a Lead of the item's team can approve.
describe('workflow enforcement', () => {
  let w: Awaited<ReturnType<typeof makeWorld>>;
  beforeEach(async () => {
    await resetDb();
    w = await makeWorld();
  });
  afterAll(() => prisma.$disconnect());

  /** bob creates + claims + submits for approval. Returns item at AWAITING_APPROVAL (version 3). */
  async function awaitingApproval() {
    const item = await createItemVia(w.bob, w.teamA.id);
    await claim(w.bob, item.id); //                                     v2 IN_PROGRESS
    const sub = await transition(w.bob, item.id, 'AWAITING_APPROVAL', 2); // v3
    expect(sub.status).toBe(200);
    return { id: item.id, version: 3 };
  }

  it('walks the full happy path and records every step in order', async () => {
    const item = await createItemVia(w.bob, w.teamA.id);
    expect((await claim(w.bob, item.id)).status).toBe(200);
    expect((await transition(w.bob, item.id, 'AWAITING_APPROVAL', 2)).status).toBe(200);
    expect((await transition(w.alice, item.id, 'RESOLVED', 3)).status).toBe(200);
    const closed = await transition(w.alice, item.id, 'CLOSED', 4);
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('CLOSED');
    expect(closed.body.version).toBe(5);

    const trail = (await dbEvents(item.id)).map((e) => `${e.type}:${e.fromValue ?? ''}>${e.toValue ?? ''}`);
    expect(trail).toEqual([
      'CREATED:>OPEN',
      'ASSIGNED:>Bob',
      'STATUS_CHANGED:OPEN>IN_PROGRESS',
      'STATUS_CHANGED:IN_PROGRESS>AWAITING_APPROVAL',
      'STATUS_CHANGED:AWAITING_APPROVAL>RESOLVED',
      'STATUS_CHANGED:RESOLVED>CLOSED',
    ]);
  });

  it('rejects invalid jumps with 422 and leaves the item untouched', async () => {
    const open = await createItemVia(w.bob, w.teamA.id);
    const jump = await transition(w.alice, open.id, 'CLOSED', 1); // OPEN -> CLOSED, even as a Lead
    expect(jump.status).toBe(422);
    expect(jump.body.error.code).toBe('INVALID_TRANSITION');
    expect((await dbItem(open.id)).status).toBe('OPEN');

    await claim(w.bob, open.id);
    const skipApproval = await transition(w.alice, open.id, 'RESOLVED', 2); // IN_PROGRESS -> RESOLVED
    expect(skipApproval.status).toBe(422);
    expect((await dbItem(open.id)).status).toBe('IN_PROGRESS');
  });

  it('a Member (even the assignee) cannot approve: 403', async () => {
    const item = await awaitingApproval();
    const res = await transition(w.bob, item.id, 'RESOLVED', item.version);
    expect(res.status).toBe(403);
    expect((await dbItem(item.id)).status).toBe('AWAITING_APPROVAL');
  });

  it('a Lead of the item\'s team can approve', async () => {
    const item = await awaitingApproval();
    const res = await transition(w.alice, item.id, 'RESOLVED', item.version);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('RESOLVED');
  });

  it('roles are per team: Lead of team B cannot approve a team A item (Grace is a MEMBER in A)', async () => {
    const item = await awaitingApproval();
    const res = await transition(w.grace, item.id, 'RESOLVED', item.version);
    expect(res.status).toBe(403); // she IS in team A, but only as a member
    expect((await dbItem(item.id)).status).toBe('AWAITING_APPROVAL');
  });

  it('a Lead who is not in the team gets 404, not a successful approval', async () => {
    const item = await awaitingApproval();
    const res = await transition(w.erin, item.id, 'RESOLVED', item.version); // Erin: LEAD of B only
    expect(res.status).toBe(404);
    expect((await dbItem(item.id)).status).toBe('AWAITING_APPROVAL');
  });

  it('only a Lead can reject (send back) or close', async () => {
    const item = await awaitingApproval();
    expect((await transition(w.bob, item.id, 'IN_PROGRESS', item.version)).status).toBe(403);
    const rejected = await transition(w.alice, item.id, 'IN_PROGRESS', item.version);
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('IN_PROGRESS');
  });

  it('only the assignee (or a Lead) may submit for approval', async () => {
    const item = await createItemVia(w.bob, w.teamA.id);
    await claim(w.bob, item.id);
    expect((await transition(w.carol, item.id, 'AWAITING_APPROVAL', 2)).status).toBe(403);
    expect((await dbItem(item.id)).status).toBe('IN_PROGRESS');
  });

  it('an unclaimed item cannot be started: it must be claimed first (422)', async () => {
    const item = await createItemVia(w.bob, w.teamA.id);
    const res = await transition(w.alice, item.id, 'IN_PROGRESS', 1);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PRECONDITION_FAILED');
  });

  it('the item detail tells each user only the transitions they may perform (UI hint, server still enforces)', async () => {
    const item = await awaitingApproval();
    const asBob = await api().get(`/api/items/${item.id}`).set(auth(w.bob));
    const asAlice = await api().get(`/api/items/${item.id}`).set(auth(w.alice));
    expect(asBob.body.allowed.transitions).toEqual([]);
    expect(asAlice.body.allowed.transitions.sort()).toEqual(['IN_PROGRESS', 'RESOLVED']);
  });

  it('rejects an unknown target status with 400', async () => {
    const item = await createItemVia(w.bob, w.teamA.id);
    const res = await transition(w.alice, item.id, 'DONE', 1);
    expect(res.status).toBe(400);
  });
});
