#!/usr/bin/env node

/**
 * SuiteCRM MCP Gateway Admin CLI (Node/Redis version)
 * Usage: mcp-admin <command> [options]
 */

import { Command } from 'commander';
import { createClient } from 'redis';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const program = new Command();

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const ENTITIES_FILE = '/etc/suitecrm-mcp/entities.json';

const redis = createClient({ url: REDIS_URL });
redis.on('error', (err) => console.error('Redis Error:', err.message));

async function connect() {
  if (!redis.isOpen) await redis.connect();
}

async function disconnect() {
  if (redis.isOpen) await redis.disconnect();
}

// --- Helpers ---

function loadEntities() {
  try {
    return JSON.parse(readFileSync(ENTITIES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function findSubByIdentifier(ident) {
  // Check if it's already a sub
  const profile = await redis.get(`mcp:profile:${ident}`);
  if (profile) return ident;

  // Search by email
  const keys = await redis.keys('mcp:profile:*');
  for (const key of keys) {
    const data = await redis.get(key);
    if (!data) continue;
    const p = JSON.parse(data);
    if (p.email === ident) return key.replace('mcp:profile:', '');
  }
  return null;
}

// --- Commands ---

program
  .name('mcp-admin')
  .description('SuiteCRM MCP Gateway admin tool')
  .version('4.4.0');

program
  .command('list')
  .description('List all user profiles')
  .action(async () => {
    await connect();
    const keys = await redis.keys('mcp:profile:*');
    if (keys.length === 0) {
      console.log('No profiles found.');
    } else {
      console.log(`Found ${keys.length} profiles:`);
      console.log('---------------------------------------------------------');
      for (const key of keys) {
        const sub = key.replace('mcp:profile:', '');
        const data = await redis.get(key);
        const p = JSON.parse(data);
        const entities = Object.keys(p.entities || {}).join(', ') || 'none';
        console.log(`${sub.padEnd(36)} | ${p.email.padEnd(25)} | Entities: ${entities}`);
      }
    }
    await disconnect();
  });

program
  .command('add')
  .description('Add or update a user profile')
  .requiredOption('--sub <sub>', 'User unique ID (from IdP)')
  .requiredOption('--entity <id>', 'Entity code (e.g., crm1)')
  .requiredOption('--user <username>', 'CRM username')
  .requiredOption('--pass <password>', 'CRM password')
  .option('--email <email>', 'User email address')
  .action(async (options) => {
    await connect();
    const { sub, entity, user, pass, email } = options;
    
    let profile = await redis.get(`mcp:profile:${sub}`);
    profile = profile ? JSON.parse(profile) : { email: email || '', entities: {} };
    
    if (email) profile.email = email;
    profile.entities = profile.entities || {};
    profile.entities[entity] = { user, pass };
    
    await redis.set(`mcp:profile:${sub}`, JSON.stringify(profile));
    console.log(`✅ Updated profile for ${sub} (Entity: ${entity})`);
    await disconnect();
  });

program
  .command('remove')
  .description('Remove a user profile or specific entity access')
  .requiredOption('--sub <sub>', 'User unique ID')
  .option('--entity <id>', 'Entity code to remove (if omitted, removes entire profile)')
  .action(async (options) => {
    await connect();
    const { sub, entity } = options;
    
    if (entity) {
      let data = await redis.get(`mcp:profile:${sub}`);
      if (!data) {
        console.error('❌ Profile not found.');
      } else {
        const profile = JSON.parse(data);
        if (profile.entities?.[entity]) {
          delete profile.entities[entity];
          await redis.set(`mcp:profile:${sub}`, JSON.stringify(profile));
          console.log(`✅ Removed entity ${entity} from profile ${sub}`);
        } else {
          console.log(`⚠️  Entity ${entity} not found in profile.`);
        }
      }
    } else {
      const deleted = await redis.del(`mcp:profile:${sub}`);
      if (deleted) console.log(`✅ Removed profile ${sub}`);
      else console.error('❌ Profile not found.');
    }
    await disconnect();
  });

program
  .command('revoke')
  .description('Instantly revoke all active sessions for a user')
  .argument('<identifier>', 'User sub or email')
  .action(async (identifier) => {
    await connect();
    const sub = await findSubByIdentifier(identifier);
    if (!sub) {
      console.error(`❌ User "${identifier}" not found.`);
      await disconnect();
      return;
    }

    const keys = await redis.keys('mcp:session:*');
    let count = 0;
    for (const key of keys) {
      const data = await redis.get(key);
      if (!data) continue;
      const s = JSON.parse(data);
      if (s.sub === sub) {
        await redis.del(key);
        count++;
      }
    }
    console.log(`✅ Revoked ${count} active session(s) for ${identifier}`);
    await disconnect();
  });

program
  .command('whoami')
  .description('Show detailed info for a user and their active sessions')
  .argument('<identifier>', 'User sub or email')
  .action(async (identifier) => {
    await connect();
    const sub = await findSubByIdentifier(identifier);
    if (!sub) {
      console.error(`❌ User "${identifier}" not found.`);
      await disconnect();
      return;
    }

    const pData = await redis.get(`mcp:profile:${sub}`);
    const profile = JSON.parse(pData);
    
    console.log('\n--- User Profile ---');
    console.log(`Sub:    ${sub}`);
    console.log(`Email:  ${profile.email}`);
    console.log('Entities:');
    for (const [code, creds] of Object.entries(profile.entities || {})) {
      console.log(`  - ${code.padEnd(10)} (User: ${creds.user})`);
    }

    const keys = await redis.keys('mcp:session:*');
    const sessions = [];
    for (const key of keys) {
      const s = await redis.get(key);
      if (!s) continue;
      const session = JSON.parse(s);
      if (session.sub === sub) {
        sessions.push({ token: key.replace('mcp:session:', ''), ...session });
      }
    }

    console.log('\n--- Active Sessions ---');
    if (sessions.length === 0) {
      console.log('No active sessions.');
    } else {
      for (const s of sessions) {
        const expires = new Date(s.expiresAt).toLocaleString();
        console.log(`Token: ${s.token.slice(0, 8)}... | Expires: ${expires}`);
      }
    }
    console.log('');
    await disconnect();
  });

program
  .command('stats')
  .description('Show Redis storage statistics')
  .action(async () => {
    await connect();
    const profiles = await redis.keys('mcp:profile:*');
    const sessions = await redis.keys('mcp:session:*');
    const bridges  = await redis.keys('mcp:bridge:*');
    const info     = await redis.info('memory');
    
    console.log('\n--- SuiteCRM MCP Stats ---');
    console.log(`Active Sessions:  ${sessions.length}`);
    console.log(`User Profiles:    ${profiles.length}`);
    console.log(`Pending Bridges:  ${bridges.length}`);
    
    const memMatch = info.match(/used_memory_human:([^\r\n]+)/);
    if (memMatch) console.log(`Redis Memory:     ${memMatch[1]}`);
    
    console.log('');
    await disconnect();
  });

program
  .command('flush')
  .description('EMERGENCY: Invalidate ALL active sessions')
  .option('--yes-i-am-sure', 'Confirm you want to kill ALL sessions')
  .action(async (options) => {
    if (!options.yesIAmSure) {
      console.error('❌ Please add --yes-i-am-sure to confirm.');
      return;
    }
    await connect();
    const keys = await redis.keys('mcp:session:*');
    for (const key of keys) await redis.del(key);
    console.log(`✅ Flushed ${keys.length} sessions. All users must log in again.`);
    await disconnect();
  });

program.parseAsync(process.argv);
