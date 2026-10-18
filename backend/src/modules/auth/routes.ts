import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { unauthorized } from '../../lib/errors';
import { currentUser, requireAuth, signToken } from '../../middleware/auth';

export const authRouter = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(200) }).strict();

// Compared against when the email is unknown, so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

authRouter.post('/login', async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) throw unauthorized('Invalid email or password'); // same message for both cases
  res.json({ token: signToken(user.id), user: { id: user.id, name: user.name, email: user.email } });
});

// Who am I, and what teams/roles do I have? (The UI uses this to populate the "team" dropdown.)
authRouter.get('/me', requireAuth, async (req, res) => {
  const user = currentUser(req);
  const teams = await prisma.team.findMany({
    where: { id: { in: [...user.memberships.keys()] } },
    orderBy: { name: 'asc' },
  });
  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    memberships: teams.map((t) => ({ teamId: t.id, teamName: t.name, role: user.memberships.get(t.id) })),
  });
});
