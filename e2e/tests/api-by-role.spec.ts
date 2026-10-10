/**
 * Every role × every protected endpoint, straight at the API (the UI hiding a button is not
 * security): a role without the permission gets 403 from the service itself; a role with it gets
 * past the guard. Endpoints and their rules come from the generated API spec, so a new endpoint is
 * covered as soon as `npm run docs` documents it; the first test fails if the spec is out of date.
 *
 * Only GETs are sent with a permitted role (they cannot change data); writes are sent only with
 * roles that must be refused, so this file never changes the stack's state.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { MATRIX_USERS, OPERATIONS, allowed, concretePath } from '../support/catalogue';
import { apiSignIn } from '../support/auth';
import { BACKEND_DIR } from '../stack/config.mjs';

const send = (api: APIRequestContext, method: string, path: string, token?: string) =>
    api.fetch(concretePath(path), {
        method,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        ...(method === 'GET' ? {} : { data: {} })
    });

test('the API spec matches the code (npm run docs:check)', () => {
    try {
        execFileSync(process.execPath, [join(BACKEND_DIR, 'scripts', 'openapi.js'), '--check'], { cwd: BACKEND_DIR, stdio: 'pipe' });
    } catch (err: any) {
        throw new Error(`The generated API docs are out of date, so this matrix would test old rules. Run \`npm run docs\` in backend/.\n${err.stdout}${err.stderr}`);
    }
});

test('without a token, every protected endpoint answers 401', async ({ request }) => {
    for (const op of OPERATIONS) {
        const res = await send(request, op.method, op.path);
        expect.soft(res.status(), `${op.method} ${op.path}`).toBe(401);
    }
});

for (const user of MATRIX_USERS) {
    test(`${user.label}: each endpoint allows or refuses by permission`, async ({ request }) => {
        const token = await apiSignIn(request, user.email);
        for (const op of OPERATIONS) {
            if (op.kind === 'user') continue;   // any signed-in user; finer rules are checked by the service tests
            if (op.kind === 'service') {
                const res = await send(request, op.method, op.path, token);
                expect.soft([401, 403], `${op.method} ${op.path} is for services only, got ${res.status()}`).toContain(res.status());
                continue;
            }
            const rule = op.allOf ? `needs ${op.allOf.join(' + ')}` : `needs one of ${op.anyOf!.join(', ')}`;
            if (!allowed(user, op)) {
                const res = await send(request, op.method, op.path, token);
                // the answer's body in the message, so an unexpected status says where it came from (API-664)
                expect.soft(res.status(), `${op.method} ${op.path} (${rule}) must be refused; got: ${res.status() === 403 ? '' : (await res.text()).slice(0, 300)}`).toBe(403);
            } else if (op.method === 'GET') {
                const res = await send(request, op.method, op.path, token);
                expect.soft([401, 403], `${op.method} ${op.path} (${rule}) must be allowed, got ${res.status()}`).not.toContain(res.status());
            }
        }
    });
}
