import { api, auth, claim, createItemVia, dbItem, makeWorld, newKey, prisma, resetDb, transition } from './helpers';

// Critical behaviour E: resource-level authorization (team-scoped), enforced on the server.
describe('resource-level authorization', () => {
  let w: Awaited<ReturnType<typeof makeWorld>>;
  let itemId: string;
  beforeEach(async () => {
    await resetDb();
    w = await makeWorld();
    itemId = (await createItemVia(w.bob, w.teamA.id, { title: 'Secret team A item' })).id;
  });
  afterAll(() => prisma.$disconnect());

  describe('a user outside the item\'s team (Frank, team B only)', () => {
    it('cannot read it: 404 (existence is not revealed)', async () => {
      expect((await api().get(`/api/items/${itemId}`).set(auth(w.frank))).status).toBe(404);
      expect((await api().get(`/api/items/${itemId}/activity`).set(auth(w.frank))).status).toBe(404);
      expect((await api().get(`/api/items/${itemId}/comments`).set(auth(w.frank))).status).toBe(404);
    });

    it('cannot modify it in any way, and nothing changes', async () => {
      const before = await dbItem(itemId);
      const patch = await api().patch(`/api/items/${itemId}`).set(auth(w.frank)).send({ version: 1, title: 'hacked' });
      const cl = await claim(w.frank, itemId);
      const tr = await transition(w.frank, itemId, 'IN_PROGRESS', 1);
      const cm = await api().post(`/api/items/${itemId}/comments`).set(auth(w.frank)).set('Idempotency-Key', newKey()).send({ body: 'hi' });

      expect([patch.status, cl.status, tr.status, cm.status]).toEqual([404, 404, 404, 404]);
      expect(await dbItem(itemId)).toEqual(before);
      expect(await prisma.comment.count()).toBe(0);
    });

    it('cannot create an item in a team they do not belong to (403)', async () => {
      const res = await api().post('/api/items').set(auth(w.frank)).set('Idempotency-Key', newKey())
        .send({ title: 'x', type: 'TASK', teamId: w.teamA.id });
      expect(res.status).toBe(403);
      expect(await prisma.workItem.count()).toBe(1);
    });

    it('never sees it in lists, search, filters or dashboard views', async () => {
      await createItemVia(w.frank, w.teamB.id, { title: 'Team B item' });
      const all = await api().get('/api/items').set(auth(w.frank));
      expect(all.body.items.map((i: { title: string }) => i.title)).toEqual(['Team B item']);

      const forced = await api().get(`/api/items?teamId=${w.teamA.id}`).set(auth(w.frank));
      expect(forced.body.items).toEqual([]);
      const search = await api().get('/api/items?q=Secret').set(auth(w.frank));
      expect(search.body.items).toEqual([]);
      for (const view of ['assigned_to_me', 'unassigned_urgent', 'awaiting_my_approval']) {
        const r = await api().get(`/api/items?view=${view}`).set(auth(w.frank));
        expect(r.body.items.every((i: { team: { id: string } }) => i.team.id === w.teamB.id)).toBe(true);
      }
    });
  });

  describe('a Viewer (Dave) can read but not write', () => {
    it('can read the item, activity and comments', async () => {
      expect((await api().get(`/api/items/${itemId}`).set(auth(w.dave))).status).toBe(200);
      expect((await api().get(`/api/items/${itemId}/activity`).set(auth(w.dave))).status).toBe(200);
      expect((await api().get(`/api/items/${itemId}/comments`).set(auth(w.dave))).status).toBe(200);
    });

    it('gets 403 on every write', async () => {
      const create = await api().post('/api/items').set(auth(w.dave)).set('Idempotency-Key', newKey())
        .send({ title: 'x', type: 'TASK', teamId: w.teamA.id });
      const patch = await api().patch(`/api/items/${itemId}`).set(auth(w.dave)).send({ version: 1, title: 'x' });
      const cl = await claim(w.dave, itemId);
      const cm = await api().post(`/api/items/${itemId}/comments`).set(auth(w.dave)).set('Idempotency-Key', newKey()).send({ body: 'x' });
      expect([create.status, patch.status, cl.status, cm.status]).toEqual([403, 403, 403, 403]);
    });
  });

  it('a Member may edit only items they created or are assigned to; a Lead may edit any', async () => {
    const carolEdit = await api().patch(`/api/items/${itemId}`).set(auth(w.carol)).send({ version: 1, title: 'by carol' });
    expect(carolEdit.status).toBe(403); // carol neither created nor owns it
    const bobEdit = await api().patch(`/api/items/${itemId}`).set(auth(w.bob)).send({ version: 1, title: 'by bob' });
    expect(bobEdit.status).toBe(200); // bob created it
    const aliceEdit = await api().patch(`/api/items/${itemId}`).set(auth(w.alice)).send({ version: 2, title: 'by alice' });
    expect(aliceEdit.status).toBe(200); // lead
  });

  it('"Awaiting my approval" only lists items in teams where I am a Lead (Grace: member in A, lead in B)', async () => {
    // one item awaiting approval in each team
    const a = await createItemVia(w.bob, w.teamA.id, { title: 'A awaiting' });
    await claim(w.bob, a.id);
    await transition(w.bob, a.id, 'AWAITING_APPROVAL', 2);
    const b = await createItemVia(w.frank, w.teamB.id, { title: 'B awaiting' });
    await claim(w.frank, b.id);
    await transition(w.frank, b.id, 'AWAITING_APPROVAL', 2);

    const res = await api().get('/api/items?view=awaiting_my_approval').set(auth(w.grace));
    expect(res.body.items.map((i: { title: string }) => i.title)).toEqual(['B awaiting']);
  });

  it('role changes take effect immediately (roles are read from the DB, not baked into the token)', async () => {
    const item = await createItemVia(w.bob, w.teamA.id);
    await claim(w.bob, item.id);
    await transition(w.bob, item.id, 'AWAITING_APPROVAL', 2);

    await prisma.membership.update({
      where: { userId_teamId: { userId: w.alice.id, teamId: w.teamA.id } },
      data: { role: 'MEMBER' },
    });
    const res = await transition(w.alice, item.id, 'RESOLVED', 3); // same token as before
    expect(res.status).toBe(403);
  });

  it('requires a valid token: 401 without or with a bad one', async () => {
    expect((await api().get('/api/items')).status).toBe(401);
    expect((await api().get('/api/items').set('Authorization', 'Bearer nonsense')).status).toBe(401);
  });

  it('a malformed id is a 404, not a server error', async () => {
    expect((await api().get('/api/items/not-a-uuid').set(auth(w.bob))).status).toBe(404);
  });
});
