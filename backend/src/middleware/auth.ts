import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../lib/prisma';
import { unauthorized } from '../lib/errors';
import type { AuthUser } from '../policy/permissions';

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export const signToken = (userId: string) =>
  jwt.sign({}, config.jwtSecret, { subject: userId, expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'] });

/**
 * Verifies the bearer token, then loads the user AND their team roles from the DB on every
 * request, so a role change takes effect immediately (nothing authorization-related lives in the token).
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized();

  let userId: string;
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    userId = String(payload.sub);
  } catch {
    throw unauthorized('Invalid or expired token');
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, include: { memberships: true } });
  if (!user) throw unauthorized('Unknown user');

  req.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    memberships: new Map(user.memberships.map((m) => [m.teamId, m.role])),
  };
  next();
}

/** For handlers behind requireAuth. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
