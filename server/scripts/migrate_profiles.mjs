/**
 * One-shot migration: reads /etc/suitecrm-mcp/user-profiles.json
 * and writes every profile into Redis crm:profiles hash.
 */
import Redis from 'ioredis';
import { readFileSync } from 'fs';

const REDIS_URL    = (process.env.REDIS_URL    || 'redis://127.0.0.1:6379').trim();
const PROFILES_FILE = process.env.PROFILES_FILE || '/etc/suitecrm-mcp/user-profiles.json';

const redis = new Redis(REDIS_URL);

async function main() {
  let profiles;
  try {
    profiles = JSON.parse(readFileSync(PROFILES_FILE, 'utf8'));
  } catch (e) {
    console.error(`Cannot read ${PROFILES_FILE}: ${e.message}`);
    process.exit(1);
  }

  const subs = Object.keys(profiles);
  if (!subs.length) { console.log('No profiles found.'); await redis.quit(); return; }

  for (const [sub, profile] of Object.entries(profiles)) {
    await redis.hset('crm:profiles', sub, JSON.stringify(profile));
    console.log(`✅  ${profile.email || sub}  →  entities: [${Object.keys(profile.entities || {}).join(', ')}]`);
  }

  console.log(`\nMigrated ${subs.length} profile(s) to Redis key crm:profiles`);
  await redis.quit();
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
