#!/usr/bin/env node
/**
 * npm run evidence -- API-606 [API-609 …]
 * npm run evidence -- API-606 --spec tests/check-extract.spec.ts
 *
 * Runs the tests tagged with those tickets (test(..., { tag: '@API-606' })) with screenshots on,
 * and lists what was taken. The files are in evidence/<ticket>/, ready to attach to the ticket.
 * With --spec, only that spec runs, with the sign-in setup and without the projects it depends on
 * (one worker, so the setup runs first): quicker for a spec that runs after the main suite.
 */
import {spawnSync} from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {E2E_DIR} from './config.mjs';

const args = process.argv.slice(2);
const specAt = args.indexOf('--spec');
const spec = specAt < 0 ? null : args[specAt + 1];
const tickets =
  specAt < 0 ? args : args.filter((_, i) => i !== specAt && i !== specAt + 1);
if (
  !tickets.length ||
  tickets.some(t => !/^[A-Z][A-Z0-9]+-\d+$/.test(t)) ||
  (specAt >= 0 && !spec)
) {
  console.error(
    'Usage: npm run evidence -- API-606 [API-609 …] [--spec tests/<file>.spec.ts]',
  );
  process.exit(2);
}
for (const t of tickets) {
  rmSync(join(E2E_DIR, 'evidence', t), {recursive: true, force: true});
}

const run = spawnSync(
  'npx',
  [
    'playwright',
    'test',
    ...(spec ? ['tests/auth.setup.ts', spec, '--no-deps', '--workers=1'] : []),
    '--grep',
    // with --spec, also the sign-in setup: its title starts "enrol the demo users"
    spec
      ? `${tickets.map(t => `@${t}`).join('|')}|enrol`
      : tickets.map(t => `@${t}`).join('|'),
  ],
  {
    cwd: E2E_DIR,
    stdio: 'inherit',
    env: {...process.env, E2E_EVIDENCE: '1'},
  },
);

for (const t of tickets) {
  const dir = join(E2E_DIR, 'evidence', t);
  const parts = join(dir, '.parts');
  if (!existsSync(parts)) {
    console.log(
      `\n${t}: no screenshots (no test tagged @${t} calls evidence())`,
    );
    continue;
  }
  // Each test wrote its own list; number all shots in source order: file, test line, step.
  const shots = readdirSync(parts)
    .filter(f => f.endsWith('.json'))
    .flatMap(f => JSON.parse(readFileSync(join(parts, f), 'utf8')))
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((s, i) => {
      const file = `${String(i + 1).padStart(2, '0')}-${s.file.split('~').pop()}`;
      renameSync(join(parts, s.file), join(dir, file));
      return {...s, file};
    });
  rmSync(parts, {recursive: true, force: true});
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(shots, null, 2));
  console.log(
    `\n${t}: ${shots.length} screenshot(s) in evidence/${t}/ (commit ${shots[0].commit})`,
  );
  for (const s of shots) console.log(`  ${s.file}  ${s.title}`);
}
process.exit(run.status ?? 1);
