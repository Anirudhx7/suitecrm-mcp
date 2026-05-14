#!/usr/bin/env node
/**
 * add_user.mjs — CLI utility to register a user CRM profile into Redis.
 *
 * Usage:
 *   node scripts/add_user.mjs <sub> <crmUser> <crmPass> [entityCode]
 *
 * Example:
 *   node scripts/add_user.mjs "auth0|abc123" "john.doe" "S3cur3P@ss" "marketing"
 *
 * The <sub> is the SSO subject identifier (from the JWT).
 * The <entityCode> is optional — defaults to the SUITECRM_CODE env var.
 */
import Redis from 'ioredis';

const [,, sub, crmUser, crmPass, entityCode] = process.argv;

if (!sub || !crmUser || !crmPass) {
  console.error('Usage: node scripts/add_user.mjs <sub> <crmUser> <crmPass> [entityCode]');
  process.exit(1);
}

const CODE  = (entityCode || process.env.SUITECRM_CODE || '').trim();
const REDIS_URL = (process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim();
const redis = new Redis(REDIS_URL);

async function main() {
  // Fetch existing profile for this sub (if any)
  const existing = await redis.hget('crm:profiles', sub);
  const profile = existing ? JSON.parse(existing) : { email: sub, entities: {} };

  if (!CODE) {
    // No entity code provided — ask user to be explicit
    console.error('No entity code. Set SUITECRM_CODE env var or pass as 4th argument.');
    await redis.quit();
    process.exit(1);
  }

  // Merge the new entity credentials into the profile
  profile.entities = profile.entities || {};
  profile.entities[CODE] = { user: crmUser, pass: crmPass };

  await redis.hset('crm:profiles', sub, JSON.stringify(profile));
  console.log(`✅ User profile saved to Redis.`);
  console.log(`   sub        : ${sub}`);
  console.log(`   entity     : ${CODE}`);
  console.log(`   crm_user   : ${crmUser}`);
  console.log(`   Redis key  : crm:profiles -> ${sub}`);

  await redis.quit();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
