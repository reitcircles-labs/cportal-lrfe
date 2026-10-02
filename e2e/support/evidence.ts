/**
 * Screenshots for Jira tickets: named checkpoints inside a test, e.g.
 *
 *   await evidence(page, 'API-606', 'Reviewer has accepted every field');
 *
 * They are taken only when E2E_EVIDENCE=1 (npm run evidence -- API-606), so ordinary runs stay
 * fast and leave nothing behind. Each lands in evidence/<ticket>/NN-<title>.png, numbered in the
 * order taken, and is listed in evidence/<ticket>/manifest.json with the commit it was taken on.
 * Every screen shows only the test stack's fictitious data.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type Page } from '@playwright/test';
import { E2E_DIR } from '../stack/config.mjs';

export const EVIDENCE_DIR = join(E2E_DIR, 'evidence');
const enabled = !!process.env.E2E_EVIDENCE;

interface Shot { file: string; title: string; test: string; commit: string; takenAt: string; }

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
    const dir = join(EVIDENCE_DIR, ticket);
    mkdirSync(dir, { recursive: true });
    const manifestFile = join(dir, 'manifest.json');
    const shots: Shot[] = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : [];
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    const file = `${String(shots.length + 1).padStart(2, '0')}-${slug}.png`;
    await page.screenshot({ path: join(dir, file) });
    shots.push({ file, title, test: test.info().titlePath.slice(1).join(' › '), commit: commit(), takenAt: new Date().toISOString() });
    writeFileSync(manifestFile, JSON.stringify(shots, null, 2));
    await test.info().attach(`${ticket} · ${title}`, { path: join(dir, file), contentType: 'image/png' });
}
