/**
 * One-time migration: re-key crm:profiles hash from Auth0 sub → email.
 * Run BEFORE deploying the updated auth.mjs / index.mjs.
 * Safe to run multiple times (idempotent):
 *   - sub-keyed entries  → moved to email key, sub saved into JSON value
 *   - email-keyed entries missing sub → sub backfilled from active auth:session:* entries
 *   - email-keyed entries already have sub → skipped
 *
 * Usage:
 *   REDIS_URL=redis://:PASSWORD@127.0.0.1:6379 node migrate-sub-to-email.mjs
 */
import Redis from 'ioredis';

const REDIS_URL = (process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim();
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });

redis.on('error', (err) => { console.error('Redis error:', err.message); });

// Scan all auth:session:* keys looking for a session whose .email matches the given
// email, and return its .sub.  Returns null if nothing found.
async function findSubFromSessions(email) {
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', 'auth:session:*', 'COUNT', 100);
    if (batch.length) {
      const values = await redis.mget(...batch);
      for (const v of values) {
        if (!v) continue;
        try {
          const s = JSON.parse(v);
          if (s.email === email && s.sub) return s.sub;
        } catch { /* skip corrupt */ }
      }
    }
    cursor = next;
  } while (cursor !== '0');
  return null;
}

async function migrate() {
  console.log(`Connecting to Redis at ${REDIS_URL.replace(/:\/\/.*@/, '://***@')} …`);
  await redis.ping();
  console.log('Connected.\n');

  const all = await redis.hgetall('crm:profiles');
  if (!all || Object.keys(all).length === 0) {
    console.log('crm:profiles is empty — nothing to migrate.');
    await redis.quit();
    return;
  }

  let migrated  = 0;
  let backfilled = 0;
  let skipped   = 0;
  let errors    = 0;

  for (const [field, raw] of Object.entries(all)) {
    let profile;
    try {
      profile = JSON.parse(raw);
    } catch {
      console.error(`  SKIP  [parse error] field="${field}"`);
      errors++;
      continue;
    }

    // ── Already email-keyed ───────────────────────────────────────────────────
    if (field.includes('@')) {
      if (profile.sub) {
        // Already fully migrated
        skipped++;
        continue;
      }
      // Email key but sub missing — try to backfill from active sessions
      const sub = await findSubFromSessions(field);
      if (sub) {
        profile.sub = sub;
        await redis.hset('crm:profiles', field, JSON.stringify(profile));
        console.log(`  BACKFILL  ${field}  ←  sub=…${sub.slice(-16)}`);
        backfilled++;
      } else {
        console.log(`  SKIP  [email-keyed, no active session found to recover sub] field="${field}"`);
        skipped++;
      }
      continue;
    }

    // ── sub-keyed entry — migrate to email key ────────────────────────────────
    const email = profile?.email;
    if (!email || !email.includes('@')) {
      console.error(`  SKIP  [no email in profile] field="${field}"`);
      errors++;
      continue;
    }

    // Collision guard: if an email-keyed profile already exists (from a prior
    // run, a live login, or another sub mapping to the same email), do NOT
    // overwrite it — it may hold newer credentials. Drop the stale sub key only
    // after confirming the email entry is present. hexists catches both the
    // initial snapshot and entries created earlier in this same run.
    if (await redis.hexists('crm:profiles', email)) {
      console.error(`  SKIP  [collision: email key "${email}" already present — keeping it] sub-field="${field}"`);
      errors++;
      continue;
    }

    // Preserve the Auth0 sub inside the JSON value
    profile.sub = field;

    await redis.pipeline()
      .hset('crm:profiles', email, JSON.stringify(profile))
      .hdel('crm:profiles', field)
      .exec();

    console.log(`  OK    ${field}  →  ${email}`);
    migrated++;
  }

  console.log(`\nDone. migrated=${migrated}  backfilled=${backfilled}  already_done=${skipped}  errors=${errors}`);
  await redis.quit();
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
