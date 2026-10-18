import { config } from '../config';
import { migrate } from '../lib/migrate';

migrate(process.env.DATABASE_URL ?? config.databaseUrl)
  .then((applied) => {
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database already up to date.');
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
