import * as activity from '../src/modules/activity/activity';
import { api, auth, claim, createItemVia, dbEvents, dbItem, makeWorld, newKey, prisma, resetDb, transition } from './helpers';

// Requirement: the item change and its activity event happen in ONE transaction.
describe('activity history is transactional and append-only', () => {
  let w: Awaited<ReturnType<typeof makeWorld>>;
  beforeEach(async () => {
    await resetDb();
    w = await makeWorld();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => prisma.$disconnect());

  it('if writing the event fails during claim, the claim is rolled back', async () => {
    const item = await createItemVia(w.alice, w.teamA.id);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(activity, 'recordEvent').mockRejectedValue(new Error('boom'));

    const res = await claim(w.bob, item.id);

    expect(res.status).toBe(500);
    const row = await dbItem(item.id);
    expect(row.assigneeId).toBeNull(); // item update did NOT persist
    expect(row.status).toBe('OPEN');
    expect(row.version).toBe(1);
  });

  it('if writing the event fails during a transition, the status change is rolled back', async () => {
    const item = await createItemVia(w.bob, w.teamA.id);
    await claim(w.bob, item.id);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(activity, 'recordEvent').mockRejectedValue(new Error('boom'));

    const res = await transition(w.bob, item.id, 'AWAITING_APPROVAL', 2);

    expect(res.status).toBe(500);
    expect((await dbItem(item.id)).status).toBe('IN_PROGRESS');
    expect((await dbItem(item.id)).version).toBe(2);
  });

  it('if writing the event fails during create, no item is left behind', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(activity, 'recordEvent').mockRejectedValue(new Error('boom'));

    const res = await api().post('/api/items').set(auth(w.bob)).set('Idempotency-Key', newKey())
      .send({ title: 'x', type: 'TASK', teamId: w.teamA.id });

    expect(res.status).toBe(500);
    expect(await prisma.workItem.count()).toBe(0);
    expect(await prisma.idempotencyKey.count()).toBe(0); // key rolled back too -> safe to retry
  });

  it('every state / owner / priority change leaves exactly one matching event', async () => {
    const item = await createItemVia(w.bob, w.teamA.id, { priority: 'LOW' });
    await claim(w.bob, item.id);
    await api().patch(`/api/items/${item.id}`).set(auth(w.alice)).send({ version: 2, priority: 'HIGH' });
    const types = (await dbEvents(item.id)).map((e) => e.type);
    expect(types).toEqual(['CREATED', 'ASSIGNED', 'STATUS_CHANGED', 'PRIORITY_CHANGED']);
  });

  it('the database itself refuses to UPDATE or DELETE activity events', async () => {
    const item = await createItemVia(w.bob, w.teamA.id);
    await expect(prisma.activityEvent.updateMany({ where: { itemId: item.id }, data: { toValue: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(prisma.activityEvent.deleteMany({ where: { itemId: item.id } })).rejects.toThrow(/append-only/);
    expect((await dbEvents(item.id)).length).toBe(1);
  });
});
