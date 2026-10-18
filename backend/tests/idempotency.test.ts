import { api, auth, createItemVia, makeWorld, newKey, prisma, resetDb, claim } from './helpers';

// Critical behaviour C: repeated POST with the same Idempotency-Key creates ONE resource.
describe('idempotency', () => {
  let w: Awaited<ReturnType<typeof makeWorld>>;
  beforeEach(async () => {
    await resetDb();
    w = await makeWorld();
  });
  afterAll(() => prisma.$disconnect());

  const create = (actor: typeof w.bob, key: string | null, body: Record<string, unknown> = {}) => {
    const req = api().post('/api/items').set(auth(actor));
    if (key) req.set('Idempotency-Key', key);
    return req.send({ title: 'Pay vendor', type: 'PAYMENT', teamId: w.teamA.id, ...body });
  };

  it('same key sent twice creates one item and returns the same response', async () => {
    const key = newKey();
    const first = await create(w.bob, key);
    const second = await create(w.bob, key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body); // the ORIGINAL result
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    expect(await prisma.workItem.count()).toBe(1);
    expect(await prisma.activityEvent.count({ where: { type: 'CREATED' } })).toBe(1); // history not duplicated
  });

  it('five simultaneous requests with the same key create exactly one item', async () => {
    const key = newKey();
    const results = await Promise.all(Array.from({ length: 5 }, () => create(w.bob, key)));

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await prisma.workItem.count()).toBe(1);
  });

  it('different keys create different items', async () => {
    const a = await create(w.bob, newKey());
    const b = await create(w.bob, newKey());
    expect(a.body.id).not.toBe(b.body.id);
    expect(await prisma.workItem.count()).toBe(2);
  });

  it('the same key with a DIFFERENT body is rejected (422), not silently replayed', async () => {
    const key = newKey();
    await create(w.bob, key, { title: 'First' });
    const res = await create(w.bob, key, { title: 'Second' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await prisma.workItem.count()).toBe(1);
  });

  it('keys are scoped per user: another user may reuse the same key string', async () => {
    const key = newKey();
    const a = await create(w.bob, key);
    const b = await create(w.carol, key);
    expect(a.body.id).not.toBe(b.body.id);
    expect(await prisma.workItem.count()).toBe(2);
  });

  it('the header is required when creating an item', async () => {
    const res = await create(w.bob, null);
    expect(res.status).toBe(400);
    expect(await prisma.workItem.count()).toBe(0);
  });

  it('a failed request does not consume the key (it can be retried)', async () => {
    const key = newKey();
    const denied = await create(w.dave, key); // dave is a VIEWER -> 403
    expect(denied.status).toBe(403);
    expect(await prisma.idempotencyKey.count()).toBe(0);
  });

  it('a double-submitted comment is stored once', async () => {
    const item = await createItemVia(w.bob, w.teamA.id);
    const key = newKey();
    const post = () => api().post(`/api/items/${item.id}/comments`).set(auth(w.bob)).set('Idempotency-Key', key).send({ body: 'On it' });
    const [a, b] = await Promise.all([post(), post()]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect(await prisma.comment.count()).toBe(1);
    expect(await prisma.activityEvent.count({ where: { type: 'COMMENT_ADDED' } })).toBe(1);
  });

  it('a retried claim (same key) returns the original 200 instead of a 409', async () => {
    const item = await createItemVia(w.alice, w.teamA.id);
    const key = newKey();
    const first = await api().post(`/api/items/${item.id}/claim`).set(auth(w.bob)).set('Idempotency-Key', key);
    const retry = await api().post(`/api/items/${item.id}/claim`).set(auth(w.bob)).set('Idempotency-Key', key);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    // ...whereas a *new* claim attempt (no key) on the same item correctly conflicts
    expect((await claim(w.bob, item.id)).status).toBe(409);
  });
});
