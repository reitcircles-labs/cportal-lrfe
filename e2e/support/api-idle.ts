/**
 * Wait until the page's API calls have finished. Playwright's 'networkidle' is not usable here:
 * a scan shown in an <iframe> (the PDF viewer on Verify and Documents) is a request that never
 * reports finished in the headless browser. Scan files are therefore left out.
 */
import type { Page, Request } from '@playwright/test';

const FILE_CONTENT = /\/api\/(intake\/files|document-content)\//;
const isApi = (r: Request) => { const p = new URL(r.url()).pathname; return p.startsWith('/api/') && !FILE_CONTENT.test(p); };

export function trackApi(page: Page) {
    const inFlight = new Set<Request>();
    page.on('request', r => { if (isApi(r)) inFlight.add(r); });
    page.on('requestfinished', r => inFlight.delete(r));
    page.on('requestfailed', r => inFlight.delete(r));
    /** Resolves once no API call has been open for `quietMs`. */
    return async function apiIdle(quietMs = 500, timeoutMs = 15_000) {
        const until = Date.now() + timeoutMs;
        let quietSince = Date.now();
        while (Date.now() < until) {
            if (inFlight.size) quietSince = Date.now();
            else if (Date.now() - quietSince >= quietMs) return;
            await page.waitForTimeout(50);
        }
        throw new Error(`API calls still open after ${timeoutMs / 1000}s: ${[...inFlight].map(r => r.url()).join(', ')}`);
    };
}
