import { loadConfig } from './config.mjs';
import { createPool, migrate } from './db.mjs';
import { log, errorCode } from './logger.mjs';

const config = loadConfig('migrate');
const pool = createPool(config.databaseUrl);
try {
  await migrate(pool);
  log('info', 'database_migrations_complete');
} catch (error) {
  log('error', 'database_migration_failed', { errorCode: errorCode(error) });
  process.exitCode = 1;
} finally {
  await pool.end();
}
