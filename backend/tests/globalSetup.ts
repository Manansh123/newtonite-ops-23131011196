// Runs once before all tests: make sure the test database exists and is migrated.
import { Client } from 'pg';
import { config } from '../src/config';
import { migrate } from '../src/lib/migrate';

export default async function globalSetup() {
  const url = new URL(config.testDatabaseUrl);
  const dbName = url.pathname.slice(1);
  if (!dbName.endsWith('_test')) throw new Error(`Test database name must end with "_test" (got ${dbName})`);

  const admin = new URL(config.testDatabaseUrl);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }
  await migrate(config.testDatabaseUrl);
}
