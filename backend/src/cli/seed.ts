// `npm run db:seed`            -> always (re)seeds. DESTRUCTIVE: wipes all tables first.
// `seed --if-empty`            -> used by `start:prod`: seeds demo data only when SEED_DEMO_DATA=true
//                                 AND the database has no users yet (so a restart never wipes anything).
import { prisma } from '../lib/prisma';
import { seedDatabase } from '../db/seed';

async function main() {
  if (process.argv.includes('--if-empty')) {
    if (process.env.SEED_DEMO_DATA !== 'true') return console.log('SEED_DEMO_DATA is not "true": not seeding.');
    if ((await prisma.user.count()) > 0) return console.log('Database already has users: not seeding.');
  }
  await seedDatabase();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
