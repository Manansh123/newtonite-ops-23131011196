import path from 'path';
import dotenv from 'dotenv';

// One .env at the repo root (see .env.example). Real env vars always win over the file.
// __dirname is backend/src (dev) or backend/dist (built): both are two levels below the repo root.
dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const isProd = process.env.NODE_ENV === 'production';

function required(name: string, devDefault: string): string {
  const v = process.env[name];
  if (v) return v;
  if (isProd) throw new Error(`Missing required env var ${name}`);
  return devDefault;
}

const jwtSecret = required('JWT_SECRET', 'dev-only-secret-change-me');
if (isProd && jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}

export const config = {
  isProd,
  databaseUrl: required('DATABASE_URL', 'postgresql://ops:ops@localhost:5432/ops'),
  testDatabaseUrl: process.env.TEST_DATABASE_URL ?? 'postgresql://ops:ops@localhost:5432/ops_test',
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  port: Number(process.env.PORT ?? 4000),
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS ?? 10),
  /** Comma-separated browser origins allowed to call the API cross-origin. Empty = same-origin only. */
  corsOrigins: (process.env.CORS_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  /** Serve the built SPA (frontend/dist) from this server. Default: on in production. */
  serveFrontend: (process.env.SERVE_FRONTEND ?? (isProd ? 'true' : 'false')) === 'true',
  frontendDist: process.env.FRONTEND_DIST ?? path.resolve(__dirname, '../../frontend/dist'),
};
