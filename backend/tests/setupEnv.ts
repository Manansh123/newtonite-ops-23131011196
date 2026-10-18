// Runs before each test file. Point the app at the TEST database, never the dev one.
import { config } from '../src/config';

const url = config.testDatabaseUrl;
if (!/_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run tests: TEST_DATABASE_URL must point at a database whose name ends in "_test" (got ${url})`);
}
process.env.DATABASE_URL = url;
process.env.BCRYPT_ROUNDS = '4'; // fast hashing in tests
