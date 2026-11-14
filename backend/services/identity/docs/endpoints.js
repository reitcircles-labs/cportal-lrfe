// What the generated openapi.yaml says about each route; paths, parameters, request bodies and
// access rules come from the routes themselves. Regenerate with `npm run docs` in backend/.
//
//   'METHOD /path': { summary, description?, tag, status? (success code), auth? (routes without a guard) }
//   auth: 'public' | 'refresh-cookie' | 'signed-link'

export const ENDPOINTS = {
  title: 'identity',
  description:
    'Sign-in with MFA, sessions, users, roles, security policies and the admin access log.',
  tags: {
    Auth: 'Sign-in, MFA, sessions. The refresh token is an httpOnly cookie `lrfe_rt` (path /api/auth), never visible to JavaScript.',
    Users: 'User administration (permission admin.users).',
    Roles: 'The six fixed roles and their permissions.',
    Policies: 'Security policies and segregation-of-duties rules.',
    Offices:
      'Office locations (registry offices and external bodies). Users other than system administrators belong to one. Offices are never deleted.',
    Organisations:
      'The organisations users and offices belong to; an install starts with one, the default organisation. Organisations are never deleted.',
    Service: 'Health and metadata.',
  },
  routes: {
    'GET /health': {tag: 'Service', summary: 'Health check', auth: 'public'},

    'POST /auth/login': {
      tag: 'Auth',
      auth: 'public',
      summary: 'Sign in with email and password',
      description:
        'Signed in: `{ accessToken, expiresIn, me }` and the refresh cookie is set. ' +
        'When MFA is required: `{ next: "mfa", challenge }`, or on first use `{ next: "mfa-enroll", challenge, secret, otpauthUrl }`; continue with POST /auth/mfa. ' +
        'Wrong email or password, or a user who is not active: 401/403.',
    },
    'POST /auth/mfa': {
      tag: 'Auth',
      auth: 'public',
      summary: 'Second step: the 6-digit authenticator code',
      description:
        'Takes the `challenge` from /auth/login. On first use this also enrols the authenticator. Returns `{ accessToken, expiresIn, me }` and sets the refresh cookie.',
    },
    'POST /auth/refresh': {
      tag: 'Auth',
      auth: 'refresh-cookie',
      summary: 'New access token from the refresh cookie',
      description:
        'Rotates the refresh cookie. 401 when the session ended (idle timeout, sign-out, suspension, replayed token).',
    },
    'POST /auth/logout': {
      tag: 'Auth',
      auth: 'refresh-cookie',
      summary: 'Sign out: ends the session and clears the cookie',
    },
    'GET /auth/me': {
      tag: 'Auth',
      summary: 'The signed-in user',
      description:
        'User, roles, permissions, home route, and the timeout / four-eyes policy.',
    },
    'POST /invitations/accept': {
      tag: 'Auth',
      auth: 'public',
      summary: 'Accept an invitation and set a password',
      description:
        'Token from the invitation link; password at least 12 characters. Returns `{ email }`; the user then signs in.',
    },

    'GET /catalogue': {
      tag: 'Roles',
      summary: 'Permission catalogue',
      description:
        '`{ groups, perms, roles }`: permission groups, every permission with its label, and the roles.',
    },
    'GET /roles': {
      tag: 'Roles',
      summary: 'The six roles with their permissions',
    },
    'PUT /roles/permissions': {
      tag: 'Roles',
      summary: 'Save the role × permission matrix',
      description:
        '`{ matrix: { roleId: [permission] } }`. Refused if no active user would keep admin.roles. Returns `{ roles, changes }`.',
    },

    'GET /users': {
      tag: 'Users',
      summary: 'All users',
      description:
        'With their roles, status, MFA state and segregation-of-duties conflicts.',
    },
    'POST /users': {
      tag: 'Users',
      status: 201,
      summary: 'Invite a user',
      description:
        "Body `{ name, email, roles, officeId, organisationId }`: an active office (required unless the roles include System administrator); an optional active organisation (by default the office's, else the inviter's, else the default organisation). Creates the user as Invited and emails them the activation link (valid 3 days). Returns `{ user, email: { sent, to, reason? }, inviteUrl? }`: " +
        'the user is created even when the email fails, and `reason` says why. `inviteUrl` is only returned when IDENTITY_EXPOSE_INVITE_LINKS=true (dev).',
    },
    'PUT /users/{id}/roles': {
      tag: 'Users',
      summary: "Set a user's roles",
      description:
        'You cannot change your own roles; no change may leave zero active administrators.',
    },
    'POST /users/{id}/suspend': {
      tag: 'Users',
      summary: 'Suspend a user',
      description:
        'Blocks sign-in and ends their sessions; history is kept. Optional `{ reason }` for the access log. You cannot suspend yourself or the last administrator.',
    },
    'POST /users/{id}/reactivate': {
      tag: 'Users',
      summary: 'Reactivate a suspended user',
      description:
        'Optional `{ reason }`. A user suspended before accepting their invitation goes back to Invited.',
    },
    'POST /users/{id}/mfa-reset': {
      tag: 'Users',
      summary: "Reset a user's MFA",
      description: 'They enrol a new authenticator at their next sign-in.',
    },
    'POST /users/{id}/invitation': {
      tag: 'Users',
      summary: 'Send a new invitation',
      description:
        'Only for users still Invited. Emails a new link (earlier links stop working). Returns `{ email, inviteUrl? }` as for POST /users.',
    },
    'PUT /users/{id}/office': {
      tag: 'Users',
      summary: 'Move a user to another office',
      description:
        '`{ officeId }`: an active office, or null for "no office" (system administrators only). Returns the user.',
    },
    'GET /offices': {
      tag: 'Offices',
      summary: 'All offices',
      description:
        '`{ offices }` with `users`: how many of their users are not suspended.',
    },
    'POST /offices': {
      tag: 'Offices',
      status: 201,
      summary: 'Add an office',
      description:
        '`code` 2 to 5 capital letters, unique and permanent (it will appear in batch and document numbers); `name`; `type` registry | external; optional `address`, `contact`, `organisationId` (an active organisation; by default the default organisation).',
    },
    'PUT /offices/{id}': {
      tag: 'Offices',
      summary: 'Rename or update an office',
      description:
        'Name, type, address, contact. The code cannot change (it is ignored if sent).',
    },
    'POST /offices/{id}/suspend': {
      tag: 'Offices',
      summary: 'Suspend an office',
      description:
        'No new invitations into it, and its pending invitations cannot be resent. Its users and their work are not changed. Optional `{ reason }`.',
    },
    'POST /offices/{id}/reactivate': {
      tag: 'Offices',
      summary: 'Reactivate an office',
      description: 'Users can be invited into it again.',
    },
    'GET /organisations': {
      tag: 'Organisations',
      summary: 'All organisations',
      description:
        '`{ organisations }` with `offices`: how many offices belong to each, and `users`: how many of its users are not suspended.',
    },
    'POST /organisations': {
      tag: 'Organisations',
      status: 201,
      summary: 'Add an organisation',
      description:
        '`code` 2 to 5 capital letters, unique and permanent; `name`.',
    },
    'PATCH /organisations/{id}': {
      tag: 'Organisations',
      summary: 'Rename an organisation',
      description: '`{ name }`. The code cannot change.',
    },
    'GET /organisations/{id}/standing': {
      tag: 'Organisations',
      summary:
        "Whether an organisation is registered and active (the product's record service only)",
      description:
        "For the service token of the domain pack's record service (land-records, or shipping-records on a shipping install): `{ id, status }`, `status` `Active` or `Suspended`, nothing else about the organisation. A B/L goes only to an active organisation (CB-34). 404 for an organisation that does not exist, 400 for an id that is not one.",
    },
    'POST /organisations/{id}/suspend': {
      tag: 'Organisations',
      summary: 'Suspend an organisation',
      description:
        'Its users cannot sign in (as if suspended) and their sessions end; their accounts are not changed. Nothing new can be added to it. Refused when no active administrator would remain. Optional `{ reason }`.',
    },
    'POST /organisations/{id}/reactivate': {
      tag: 'Organisations',
      summary: 'Reactivate an organisation',
      description: 'Its users can sign in again.',
    },
    'GET /access-log': {
      tag: 'Users',
      summary: 'Admin access log',
      description:
        'Sign-ins, denials, user, role and policy changes, newest first. `{ items, total }`.',
    },

    'GET /policies': {
      tag: 'Policies',
      summary: 'Security policies and segregation-of-duties rules',
    },
    'GET /policies/effective': {
      tag: 'Policies',
      summary: 'The policies other services enforce (land-records)',
      description:
        'For the land-records service token: `{ fourEyes }`, the security policy Four-eyes finalization as set now. Read when a land record version is submitted and approved (API-663).',
    },
    'PUT /policies': {
      tag: 'Policies',
      summary: 'Save policies and switch rules on or off',
      description: 'Returns `{ policies, sod, changes }`.',
    },
  },
};
