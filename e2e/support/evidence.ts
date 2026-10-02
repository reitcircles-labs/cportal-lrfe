/**
 * Screenshots for Jira tickets: named checkpoints inside a test, e.g.
 *
 *   await evidence(page, 'API-606', 'Reviewer has accepted every field');
 *
 * They are taken only when E2E_EVIDENCE=1 (npm run evidence -- API-606), so ordinary runs stay
 * fast and leave nothing behind. Tests of one ticket may run in parallel, so each test keeps its own
 * list (evidence/<ticket>/.parts/) and names its files by its place in the source; afterwards
 * stack/evidence.mjs numbers them in that order (NN-<title>.png) and writes manifest.json with the
 * commit they were taken on. Every screen shows only the test stack's fictitious data.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test, type Page } from '@playwright/test';
import { E2E_DIR } from '../stack/config.mjs';

export const EVIDENCE_DIR = join(E2E_DIR, 'evidence');
const enabled = !!process.env.E2E_EVIDENCE;

export interface Shot { file: string; title: string; test: string; commit: string; takenAt: string; }

/** Shots taken so far by the running test, per ticket. */
const taken = new Map<string, Shot[]>();

function commit() {
    try {
        const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: E2E_DIR }).toString().trim();
        const dirty = execFileSync('git', ['status', '--porcelain', '--', '..'], { cwd: E2E_DIR }).toString().split('\n')
            .some(l => l && !l.startsWith('??'));
        return dirty ? `${sha} + uncommitted changes` : sha;
    } catch { return 'unknown'; }
}

export async function evidence(page: Page, ticket: string, title: string) {
    if (!enabled) return;
    await page.waitForTimeout(800);   // let the PDF viewer draw the scan and transitions finish
    const info = test.info();
    const parts = join(EVIDENCE_DIR, ticket, '.parts');
    mkdirSync(parts, { recursive: true });
    const key = `${ticket}:${info.testId}`;
    const shots = taken.get(key) ?? [];
    taken.set(key, shots);
    // sorts by spec file, then the test's line, then the order within the test
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    const file = `${basename(info.file)}~${String(info.line).padStart(5, '0')}~${String(shots.length + 1).padStart(2, '0')}~${slug}.png`;
    await page.screenshot({ path: join(parts, file) });
    shots.push({ file, title, test: info.titlePath.slice(1).join(' › '), commit: commit(), takenAt: new Date().toISOString() });
    writeFileSync(join(parts, `${info.testId}.json`), JSON.stringify(shots, null, 2));
    await info.attach(`${ticket} · ${title}`, { path: join(parts, file), contentType: 'image/png' });
}
