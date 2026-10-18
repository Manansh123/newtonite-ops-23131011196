import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from '../config';

// Read DATABASE_URL at call time so the test setup can point this at the test database.
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? config.databaseUrl, max: 20 }),
  // Concurrent requests queue on row locks inside transactions; give them room before timing out.
  transactionOptions: { maxWait: 10_000, timeout: 15_000 },
});

// The `tx` handed to prisma.$transaction(async (tx) => ...)
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
