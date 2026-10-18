import { api, auth, claim, createItemVia, dbEvents, dbItem, makeUser, makeWorld, prisma, resetDb } from './helpers';

// Critical behaviour A: two users claim the same unassigned item at the same time.
describe('concurrent claim', () => {
  let w: Awaited<ReturnType<typeof makeWorld>>;
  beforeEach(async () => {
    await resetDb();
    w = await makeWorld();
  });
  afterAll(() => prisma.$disconnect());

  it('exactly one of two parallel claims succeeds; the other gets 409', async () => {
    const item = await createItemVia(w.alice, w.teamA.id);

    const [r1, r2] = await Promise.all([claim(w.bob, item.id), claim(w.carol, item.id)]);

    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const winner = r1.status === 200 ? w.bob : w.carol;
    const loser = r1.status === 200 ? r2 : r1;

    // loser is told why, and gets the current state
    expect(loser.body.error.code).toBe('ALREADY_CLAIMED');
    expect(loser.body.latest.assignee.id).toBe(winner.id);

    // database agrees: single owner, version bumped once, ONE assignment event
    const row = await dbItem(item.id);
    expect(row.assigneeId).toBe(winner.id);
    expect(row.status).toBe('IN_PROGRESS');
    expect(row.version).toBe(2);
    const events = await dbEvents(item.id);
    expect(events.filter((e) => e.type === 'ASSIGNED')).toHaveLength(1);
  });

  it('with 8 simultaneous claimers there is still exactly one winner', async () => {
    const item = await createItemVia(w.alice, w.teamA.id);
    const claimers = await Promise.all(
      Array.from({ length: 8 }, (_, i) => makeUser(`Claimer${i}`, [[w.teamA.id, 'MEMBER']])),
    );

    const results = await Promise.all(claimers.map((c) => claim(c, item.id)));

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    const winnerIdx = results.findIndex((r) => r.status === 200);
    expect((await dbItem(item.id)).assigneeId).toBe(claimers[winnerIdx]!.id);
    expect((await dbItem(item.id)).version).toBe(2);
    expect((await dbEvents(item.id)).filter((e) => e.type === 'ASSIGNED')).toHaveLength(1);
  });

  it('a later claim on an already-claimed item is 409 and changes nothing', async () => {
    const item = await createItemVia(w.alice, w.teamA.id);
    expect((await claim(w.bob, item.id)).status).toBe(200);

    const res = await claim(w.carol, item.id);

    expect(res.status).toBe(409);
    const row = await dbItem(item.id);
    expect(row.assigneeId).toBe(w.bob.id);
    expect(row.version).toBe(2);
  });

  it('a viewer cannot claim (403) and the item stays unassigned', async () => {
    const item = await createItemVia(w.alice, w.teamA.id);
    const res = await claim(w.dave, item.id);
    expect(res.status).toBe(403);
    expect((await dbItem(item.id)).assigneeId).toBeNull();
  });

  it('claiming moves the item OPEN -> IN_PROGRESS and records who did it', async () => {
    const item = await createItemVia(w.alice, w.teamA.id);
    const res = await claim(w.bob, item.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('IN_PROGRESS');
    expect(res.body.assignee.id).toBe(w.bob.id);

    const activity = await api().get(`/api/items/${item.id}/activity`).set(auth(w.bob));
    expect(activity.body.events.map((e: { type: string }) => e.type)).toEqual(['CREATED', 'ASSIGNED', 'STATUS_CHANGED']);
  });
});
