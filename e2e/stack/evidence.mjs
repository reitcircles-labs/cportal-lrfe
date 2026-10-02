#!/usr/bin/env node
/**
 * npm run evidence -- API-606 [API-609 …]
 *
 * Runs the tests tagged with those tickets (test(..., { tag: '@API-606' })) with screenshots on,
 * and lists what was taken. The files are in evidence/<ticket>/, ready to attach to the ticket.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_DIR } from './config.mjs';

const tickets = process.argv.slice(2);
if (!tickets.length || tickets.some(t => !/^[A-Z][A-Z0-9]+-\d+$/.test(t))) {
    console.error('Usage: npm run evidence -- API-606 [API-609 …]');
    process.exit(2);
}
for (const t of tickets) rmSync(join(E2E_DIR, 'evidence', t), { recursive: true, force: true });

const run = spawnSync('npx', ['playwright', 'test', '--grep', tickets.map(t => `@${t}`).join('|')], {
    cwd: E2E_DIR, stdio: 'inherit', env: { ...process.env, E2E_EVIDENCE: '1' }
});

for (const t of tickets) {
    const manifest = join(E2E_DIR, 'evidence', t, 'manifest.json');
    if (!existsSync(manifest)) { console.log(`\n${t}: no screenshots (no test tagged @${t} calls evidence())`); continue; }
    const shots = JSON.parse(readFileSync(manifest, 'utf8'));
    console.log(`\n${t}: ${shots.length} screenshot(s) in evidence/${t}/ (commit ${shots[0].commit})`);
    for (const s of shots) console.log(`  ${s.file}  ${s.title}`);
}
process.exit(run.status ?? 1);
