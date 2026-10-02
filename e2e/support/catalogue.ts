/**
 * What the tests expect, read from the application's own sources so the matrix follows any change
 * to roles, screens or endpoints without editing the tests:
 *
 *   roles & permissions   backend/services/identity/src/catalogue.js
 *   demo users            backend/services/identity/src/seed.js (DEMO_USERS)
 *   screens               angular-app/src/app/app.routes.ts (path, required permission, title)
 *   API access rules      backend/services/gateway/docs/openapi.yaml (x-access, from the route guards)
 *
 * The routes file is TypeScript that imports Angular components, so it is parsed as text. The
 * parser fails loudly on anything it does not understand rather than testing fewer screens.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { ROLES as ROLES_JS, effectivePerms } from '../../backend/services/identity/src/catalogue.js';
import { DEMO_USERS as DEMO_USERS_JS } from '../../backend/services/identity/src/seed.js';
import { ANGULAR_DIR, BACKEND_DIR } from '../stack/config.mjs';

interface DemoUser { name: string; email: string; office: string; roles: string[]; status: 'Active' | 'Suspended' | 'Invited'; }
const ROLES = ROLES_JS as { id: string; home: string; perms: string[] }[];
const DEMO_USERS = DEMO_USERS_JS as DemoUser[];

export type RoleId = 'sup' | 'scan' | 'rev' | 'rec' | 'aud' | 'adm';

export interface TestUser {
    name: string;
    email: string;
    roles: RoleId[];
    perms: string[];
    /** Where sign-in lands: the first role's home screen. */
    home: string;
    /** Short label for test titles, e.g. "scan+rev (d.garoeb)". */
    label: string;
}

const toTestUser = (u: DemoUser): TestUser => ({
    name: u.name,
    email: u.email,
    roles: u.roles as RoleId[],
    perms: effectivePerms(u.roles, ROLES),
    home: ROLES.find(r => r.id === u.roles[0])!.home,
    label: `${u.roles.join('+')} (${u.email.split('@')[0]})`
});

const active = DEMO_USERS.filter(u => u.status === 'Active');

/** Enrols its authenticator through the sign-in screen in sign-in.spec.ts; left alone by the setup. */
export const MFA_UI_USER = 's.nangolo@deeds.gov.na';

/**
 * The users every matrix runs as: one active user per role (holding only that role), plus every
 * active user with several roles (their permissions are the union).
 */
export const MATRIX_USERS: TestUser[] = [
    ...ROLES.map(r => active.find(u => u.email !== MFA_UI_USER && u.roles.length === 1 && u.roles[0] === r.id)),
    ...active.filter(u => u.roles.length > 1)
].map(u => {
    if (!u) throw new Error('A role has no active single-role demo user in DEMO_USERS: the matrix needs one per role');
    return toTestUser(u);
});

/** Every active demo user except MFA_UI_USER: the setup enrols each one's authenticator. */
export const ENROLLED_USERS: TestUser[] = active.filter(u => u.email !== MFA_UI_USER).map(toTestUser);

export const userByRole = (role: RoleId) => MATRIX_USERS.find(u => u.roles.length === 1 && u.roles[0] === role)!;
export const demoUser = (status: 'Suspended' | 'Invited') => DEMO_USERS.find(u => u.status === status)!;
export const can = (user: TestUser, anyOf: string[]) => anyOf.some(p => user.perms.includes(p));

// ---------------------------------------------------------------- screens (app.routes.ts)

export interface Screen {
    /** URL path without the leading slash ('' is the dashboard). */
    path: string;
    /** The user needs at least one of these. */
    anyOf: string[];
    /** Shown in the top bar's heading. */
    title: string;
}

function parseScreens(): Screen[] {
    const file = join(ANGULAR_DIR, 'src', 'app', 'app.routes.ts');
    const src = readFileSync(file, 'utf8');
    const consts = new Map<string, string[]>();
    for (const m of src.matchAll(/const (\w+)\s*=\s*\[([^\]]*)\];/g)) {
        consts.set(m[1], [...m[2].matchAll(/'([^']+)'/g)].map(x => x[1]));
    }
    const screens: Screen[] = [];
    for (const line of src.split('\n')) {
        if (!/^\s*\{\s*path:/.test(line)) continue;
        const path = line.match(/path:\s*'([^']*)'/)![1];
        if (/redirectTo:/.test(line) || !/perm:/.test(line)) continue;   // login, invite, denied, redirects
        const permExpr = line.match(/perm:\s*('[^']+'|\w+)/)?.[1];
        const title = line.match(/title:\s*'([^']+)'/)?.[1];
        if (!permExpr || !title) throw new Error(`${file}: cannot read the permission or title of route '${path}'`);
        const anyOf = permExpr.startsWith("'") ? [permExpr.slice(1, -1)] : consts.get(permExpr);
        if (!anyOf?.length) throw new Error(`${file}: route '${path}' uses ${permExpr}, which is not a const array of permissions in that file`);
        screens.push({ path, anyOf, title });
    }
    if (screens.length < 10) throw new Error(`${file}: found only ${screens.length} guarded routes; has the file's format changed?`);
    return screens;
}

export const SCREENS = parseScreens();

// ---------------------------------------------------------------- API (gateway openapi.yaml)

export interface Operation {
    method: string;
    /** As documented, e.g. /api/users/{id}/roles */
    path: string;
    /** 'perm': a user token with allOf/anyOf; 'user': any signed-in user; 'service': service tokens only. */
    kind: 'perm' | 'user' | 'service';
    allOf?: string[];
    anyOf?: string[];
}

export const OPENAPI_FILE = join(BACKEND_DIR, 'services', 'gateway', 'docs', 'openapi.yaml');

function parseOperations(): Operation[] {
    const spec = loadYaml(readFileSync(OPENAPI_FILE, 'utf8')) as any;
    const ops: Operation[] = [];
    for (const [path, item] of Object.entries<any>(spec.paths)) {
        for (const [method, op] of Object.entries<any>(item)) {
            const schemes = (op.security || []).flatMap((s: object) => Object.keys(s));
            const access = op['x-access'] || {};
            if (schemes.includes('bearerAuth')) {
                if (access.allOf || access.anyOf) ops.push({ method: method.toUpperCase(), path, kind: 'perm', allOf: access.allOf, anyOf: access.anyOf });
                else ops.push({ method: method.toUpperCase(), path, kind: 'user' });
            } else if (schemes.includes('serviceToken')) {
                ops.push({ method: method.toUpperCase(), path, kind: 'service' });
            }
            // no scheme or refreshCookie: public, signed links and the refresh cookie are tested elsewhere
        }
    }
    if (!ops.some(o => o.kind === 'perm')) throw new Error(`${OPENAPI_FILE}: no endpoint with x-access permissions; has the generator changed?`);
    return ops;
}

export const OPERATIONS = parseOperations();

export const allowed = (user: TestUser, op: Operation) =>
    (op.allOf ?? []).every(p => user.perms.includes(p)) && (!op.anyOf || can(user, op.anyOf));

/** A concrete URL for a documented path: path parameters get placeholder values that match nothing. */
export const concretePath = (path: string) =>
    path.replace(/\{(\w+)\}/g, (_, name) => (name === 'n' ? '1' : name === 'k' ? 'titleDeedNo' : '00000000-0000-4000-8000-000000000000'));
