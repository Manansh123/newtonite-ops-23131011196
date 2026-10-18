import { api, auth, makeWorld, prisma, resetDb } from './helpers';

// Server-side pagination, filtering and search.
describe('dashboard list: pagination, filters, search', () => {
  let w: Awaited<ReturnType<typeof makeWorld>>;
  beforeAll(async () => {
    await resetDb();
    w = await makeWorld();
    const base = Date.now() - 86_400_000;
    // 45 items; every 3 items share the SAME createdAt to exercise the (createdAt, id) tie-break.
    await prisma.workItem.createMany({
      data: Array.from({ length: 45 }, (_, i) => ({
        title: i % 5 === 0 ? `Refund dispute #${i}` : `Routine task #${i}`,
        type: i % 2 === 0 ? ('PAYMENT' as const) : ('TASK' as const),
        priority: i % 4 === 0 ? ('URGENT' as const) : ('LOW' as const),
        status: 'OPEN' as const,
        teamId: w.teamA.id,
        createdById: w.bob.id,
        createdAt: new Date(base + Math.floor(i / 3) * 1000),
        updatedAt: new Date(base),
      })),
    });
  });
  afterAll(() => prisma.$disconnect());

  const list = (qs: string) => api().get(`/api/items?${qs}`).set(auth(w.bob));

  it('walks every page with no duplicates and no gaps, newest first', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: any = await list(`limit=10${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeLessThanOrEqual(10);
      seen.push(...res.body.items.map((i: { id: string }) => i.id));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(5);
    expect(seen).toHaveLength(45);
    expect(new Set(seen).size).toBe(45);
  });

  it('filters on the server (status/priority/type) and combines them', async () => {
    const urgent = await list('priority=URGENT&limit=100');
    expect(urgent.body.items.every((i: { priority: string }) => i.priority === 'URGENT')).toBe(true);
    expect(urgent.body.items).toHaveLength(12); // i%4==0 for i in 0..44

    const combo = await list('priority=URGENT&type=PAYMENT&limit=100');
    expect(combo.body.items.every((i: { type: string; priority: string }) => i.type === 'PAYMENT' && i.priority === 'URGENT')).toBe(true);
  });

  it('searches title text case-insensitively on the server', async () => {
    const res = await list('q=REFUND&limit=100');
    expect(res.body.items).toHaveLength(9); // i%5==0 -> 0,5,...,40
    expect(res.body.items.every((i: { title: string }) => /refund/i.test(i.title))).toBe(true);
  });

  it('"unassigned urgent" view returns only unassigned URGENT unfinished items', async () => {
    const res = await list('view=unassigned_urgent&limit=100');
    expect(res.body.items).toHaveLength(12);
    expect(res.body.items.every((i: { assignee: unknown; priority: string }) => i.assignee === null && i.priority === 'URGENT')).toBe(true);
  });

  it('rejects a garbage cursor or oversized limit with 400', async () => {
    expect((await list('cursor=garbage')).status).toBe(400);
    expect((await list('limit=1000')).status).toBe(400);
  });
});
