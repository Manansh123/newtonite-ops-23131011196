import bcrypt from 'bcryptjs';
import { api, auth, makeWorld, prisma, resetDb } from './helpers';

describe('login', () => {
  beforeAll(async () => {
    await resetDb();
    const w = await makeWorld();
    await prisma.user.update({ where: { id: w.bob.id }, data: { passwordHash: await bcrypt.hash('correct horse', 4), email: 'bob@test.local' } });
  });
  afterAll(() => prisma.$disconnect());

  it('returns a token that works on protected routes', async () => {
    const res = await api().post('/api/auth/login').send({ email: 'bob@test.local', password: 'correct horse' });
    expect(res.status).toBe(200);
    const me = await api().get('/api/auth/me').set({ Authorization: `Bearer ${res.body.token}` });
    expect(me.status).toBe(200);
    expect(me.body.memberships).toEqual([expect.objectContaining({ teamName: 'Team A', role: 'MEMBER' })]);
  });

  it('wrong password and unknown email give the same 401 (no user enumeration)', async () => {
    const wrongPw = await api().post('/api/auth/login').send({ email: 'bob@test.local', password: 'nope' });
    const unknown = await api().post('/api/auth/login').send({ email: 'nobody@test.local', password: 'nope' });
    expect(wrongPw.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe(wrongPw.body.error.message);
  });

  it('never returns the password hash', async () => {
    const res = await api().post('/api/auth/login').send({ email: 'bob@test.local', password: 'correct horse' });
    expect(JSON.stringify(res.body)).not.toMatch(/hash|\$2[aby]\$/);
  });
});
