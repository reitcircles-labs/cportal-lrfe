/**
 * The shipping demo install's settings and guards (CB-49): a second demo install, for the shipping
 * product, beside the land registry's (project lrfe), which it must never touch.
 * Run with: node --test demo/shipping-install.test.mjs
 */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  DEMO_ENV_FILE,
  RELAY_SERVICE,
  REHEARSAL_TEARDOWN_PROFILES,
  SHIPPING_DEMO,
  SHIPPING_LOCK_FILE,
  SHIPPING_REHEARSAL,
  SHIPPING_RELAY_FILE,
  landNetworkProblems,
  newSecret,
  nodeNetworkProblems,
  parseSettings,
  rollbackCommand,
  shippingSettings,
  shippingTargetProblems,
  withSettings,
} from './shipping-install.mjs';

const DEMO_DIR = dirname(fileURLToPath(import.meta.url));
const DEPLOY = join(DEMO_DIR, '..', 'deploy');

/** The land demo's settings as far as these tests need them (made-up secrets). */
const LAND_ENV = [
  '# the demo install',
  'LRFE_VERSION=0.1.0-575d568',
  'LRFE_PUBLIC_URL=http://localhost:8088',
  'LRFE_BIND=127.0.0.1',
  'LRFE_HTTP_PORT=8088',
  'COOKIE_SECURE=false',
  'LRFE_ORG_NAME=Deeds Registry',
  'LRFE_ORG_SUBTITLE=Republic of Namibia',
  'LRFE_ORG_PARENT=Ministry of Land',
  'LRFE_ORG_PLACE=Windhoek',
  'LRFE_OFFICES=WDH=Deeds Registry · Windhoek',
  'JWT_SECRET=land-jwt-secret-land-jwt-secret-land-jwt-secret-1',
  'POSTGRES_PASSWORD=land-postgres-password',
  'POSTGRES_USER=lrfe',
  'BOOTSTRAP_ADMIN_EMAIL=admin@example.org',
  'BOOTSTRAP_ADMIN_PASSWORD=land-admin-password',
  'SEED_DEMO_PASSWORD=land-demo-password',
  'MAIL_TRANSPORT=none',
  'EXTRACTION_PROVIDER=gemini',
  'GEMINI_API_KEY=land-ai-key',
  'JEV_ENABLED=true',
  'TYPESAFE_API_KEY=land-check-key',
  'EDRMS_STORAGE=s3',
  'AWS_BUCKET_NAME=land-bucket',
  'AWS_ACCESS_KEY_ID=land-access-key',
  'AWS_SECRET_ACCESS_KEY=land-secret-access-key',
  'COMPOSE_PROFILES=postgres,docs,bao,blockchain,search',
  'COMPOSE_FILE=docker-compose.yml:../demo/compose.keep-volumes.yml',
  'LRFE_DOCS_PORT=3510',
  'CARDANO_PROVIDER=ogmios',
  'CARDANO_NETWORK=preview',
  'ANCHOR_PERIOD=5m',
  'LRFE_SEAL=bao',
  'LRFE_SEAL_CERT=-----BEGIN CERTIFICATE-----\\nland\\n-----END CERTIFICATE-----',
  'OPENSEARCH_DATA_DIR=/srv/land-search',
  'LRFE_TIME_ZONE=Africa/Windhoek',
  '',
].join('\n');

const LAND_SECRETS = [
  'land-jwt-secret-land-jwt-secret-land-jwt-secret-1',
  'land-postgres-password',
  'land-admin-password',
  'land-demo-password',
  'land-ai-key',
  'land-check-key',
  'land-access-key',
  'land-secret-access-key',
];

/** The shipping demo's settings made from the land demo's. */
function shipping(overrides = {}) {
  return parseSettings(
    shippingSettings(LAND_ENV, {
      version: '0.1.0-abc1234',
      port: '8089',
      composeFile: `docker-compose.yml:${SHIPPING_LOCK_FILE}`,
      ...overrides,
    }),
  );
}

/** A correct shipping target, to be spoilt one thing at a time. */
function target(overrides = {}) {
  return {
    project: SHIPPING_DEMO.project,
    envFile: SHIPPING_DEMO.envFile,
    settings: shipping(),
    composeFiles: [
      {
        file: join(DEPLOY, 'docker-compose.yml'),
        text: 'services: {}\nvolumes:\n  bao-data:\n',
      },
      {
        file: join(DEMO_DIR, 'compose.keep-volumes.shipping.yml'),
        text: readFileSync(
          join(DEMO_DIR, 'compose.keep-volumes.shipping.yml'),
          'utf8',
        ),
      },
    ],
    demoSettings: parseSettings(LAND_ENV),
    ...overrides,
  };
}

// ------------------------------------------------------------------------------- the two installs

test("the shipping demo: its own project, port and settings file, never the land demo's", () => {
  assert.equal(SHIPPING_DEMO.project, 'lrfe-shipping');
  assert.equal(SHIPPING_DEMO.port, '8089');
  assert.equal(SHIPPING_DEMO.envFile, join(DEPLOY, '.env.shipping'));
  assert.notEqual(SHIPPING_DEMO.envFile, DEMO_ENV_FILE);
  assert.equal(DEMO_ENV_FILE, join(DEPLOY, '.env'));
  assert.match(SHIPPING_DEMO.initFile, /lrfe-shipping-openbao-init\.json$/);
});

test('the shipping rehearsal: a throwaway project and port of its own', () => {
  assert.equal(SHIPPING_REHEARSAL.project, 'lrfe-rehearsal-shipping');
  for (const taken of ['8088', '8089', '8716']) {
    assert.notEqual(SHIPPING_REHEARSAL.port, taken);
  }
  assert.notEqual(SHIPPING_REHEARSAL.project, SHIPPING_DEMO.project);
  assert.match(SHIPPING_REHEARSAL.dir, /\.lrfe-rehearsal-shipping$/);
});

test('the shipping settings file is never committed', () => {
  const ignored = readFileSync(join(DEPLOY, '.gitignore'), 'utf8')
    .split('\n')
    .map(line => line.trim());
  assert.ok(ignored.includes('.env.shipping'));
});

// --------------------------------------------------------------------------------------- settings

test('the shipping settings: the product, its profile, its port and address, its version', () => {
  const settings = shipping();
  assert.equal(settings.LRFE_DOMAIN, 'shipping');
  assert.equal(settings.COMPOSE_PROFILES, 'postgres,bao,shipping');
  assert.equal(settings.LRFE_HTTP_PORT, '8089');
  assert.equal(settings.LRFE_PUBLIC_URL, 'http://localhost:8089');
  assert.equal(settings.LRFE_VERSION, '0.1.0-abc1234');
  assert.equal(
    settings.COMPOSE_FILE,
    'docker-compose.yml:../demo/compose.keep-volumes.shipping.yml',
  );
});

test("the shipping settings: new secrets, none of the land demo's", () => {
  const text = shippingSettings(LAND_ENV, {
    version: '0.1.0-abc1234',
    port: '8089',
    composeFile: 'docker-compose.yml',
  });
  for (const secret of LAND_SECRETS) {
    assert.equal(text.includes(secret), false, `${secret} is carried over`);
  }
  const settings = parseSettings(text);
  for (const name of [
    'JWT_SECRET',
    'POSTGRES_PASSWORD',
    'SEED_DEMO_PASSWORD',
    'BOOTSTRAP_ADMIN_PASSWORD',
  ]) {
    assert.ok(settings[name].length >= 48, `${name} is long enough`);
  }
  const again = parseSettings(
    shippingSettings(LAND_ENV, {
      version: '0.1.0-abc1234',
      port: '8089',
      composeFile: 'docker-compose.yml',
    }),
  );
  assert.notEqual(again.JWT_SECRET, settings.JWT_SECRET);
});

test('the shipping settings: no AI, no document check, no shared bucket, no search directory', () => {
  const settings = shipping();
  assert.equal(settings.EXTRACTION_PROVIDER, 'mock');
  assert.equal(settings.GEMINI_API_KEY, '');
  assert.equal(settings.JEV_ENABLED, 'false');
  assert.equal(settings.TYPESAFE_API_KEY, '');
  assert.equal(settings.EDRMS_STORAGE, 'local');
  assert.equal(settings.AWS_BUCKET_NAME, '');
  assert.equal(settings.AWS_ACCESS_KEY_ID, '');
  assert.equal(settings.AWS_SECRET_ACCESS_KEY, '');
  assert.equal(settings.OPENSEARCH_DATA_DIR, '');
});

test('the shipping settings: anchoring off, no seal, the title signer set only after its setup', () => {
  const settings = shipping();
  assert.equal(settings.CARDANO_PROVIDER, '');
  assert.equal(settings.LRFE_SEAL, '');
  assert.equal(settings.LRFE_SEAL_CERT, '');
  assert.equal(settings.TITLE_SIGNER, '');
});

test("the shipping settings: the land registry's organisation texts and offices are not carried over", () => {
  const settings = shipping();
  for (const name of [
    'LRFE_ORG_NAME',
    'LRFE_ORG_SUBTITLE',
    'LRFE_ORG_PARENT',
    'LRFE_ORG_PLACE',
  ]) {
    assert.equal(name in settings, false, `${name} is still there`);
  }
  assert.equal(settings.LRFE_OFFICES, '');
});

test("the shipping settings: the land demo's other settings kept (mail, time zone, sign-in)", () => {
  const settings = shipping();
  assert.equal(settings.MAIL_TRANSPORT, 'none');
  assert.equal(settings.LRFE_TIME_ZONE, 'Africa/Windhoek');
  assert.equal(settings.COOKIE_SECURE, 'false');
  assert.equal(settings.BOOTSTRAP_ADMIN_EMAIL, 'admin@example.org');
  assert.equal(settings.LRFE_BIND, '127.0.0.1');
});

test('the shipping settings: an empty base still gives a complete shipping install', () => {
  const settings = parseSettings(
    shippingSettings('', {
      version: '0.1.0-abc1234',
      port: '8717',
      composeFile: 'docker-compose.yml',
    }),
  );
  assert.equal(settings.LRFE_DOMAIN, 'shipping');
  assert.equal(settings.LRFE_HTTP_PORT, '8717');
  assert.ok(settings.JWT_SECRET.length >= 48);
});

test('a new secret: long, random, and safe inside a database address', () => {
  const secrets = new Set();
  for (let i = 0; i < 50; i++) {
    const secret = newSecret();
    assert.match(secret, /^[A-Za-z0-9_-]{48,}$/);
    secrets.add(secret);
  }
  assert.equal(secrets.size, 50);
});

test('settings: replaced in place, added at the end, other lines and comments kept', () => {
  const text = withSettings('# a comment\nexport A=1\nB="two words"\nC=3\n', {
    A: '10',
    D: '4',
  });
  assert.equal(text, '# a comment\nA=10\nB="two words"\nC=3\nD=4\n');
  assert.deepEqual(parseSettings(text), {
    A: '10',
    B: 'two words',
    C: '3',
    D: '4',
  });
});

// ----------------------------------------------------------------------------------------- guards

test('guard: a correct shipping target passes', () => {
  assert.deepEqual(shippingTargetProblems(target()), []);
});

test("guard: never the land demo's project, nor the land rehearsal's", () => {
  for (const project of ['lrfe', 'lrfe-rehearsal']) {
    const problems = shippingTargetProblems(target({project}));
    assert.equal(problems.length, 1, project);
    assert.match(problems[0], new RegExp(`project ${project}`));
  }
});

test("guard: never the land demo's settings file, however its path is written", () => {
  for (const envFile of [
    DEMO_ENV_FILE,
    join(DEPLOY, '.', '.env'),
    join(DEPLOY, '..', 'deploy', '.env'),
  ]) {
    const problems = shippingTargetProblems(target({envFile}));
    assert.equal(problems.length, 1, envFile);
    assert.match(problems[0], /the land demo's settings/);
  }
});

test('guard: the install must be of the shipping product, with its profile', () => {
  const land = shippingTargetProblems(
    target({settings: {...shipping(), LRFE_DOMAIN: 'land'}}),
  );
  assert.equal(land.length, 1);
  assert.match(land[0], /LRFE_DOMAIN=shipping/);
  const noProfile = shippingTargetProblems(
    target({settings: {...shipping(), COMPOSE_PROFILES: 'postgres,bao'}}),
  );
  assert.equal(noProfile.length, 1);
  assert.match(noProfile[0], /profile shipping/);
});

test("guard: no blockchain node of its own (a second node next to the demo's is the user's decision)", () => {
  const problems = shippingTargetProblems(
    target({
      settings: {
        ...shipping(),
        COMPOSE_PROFILES: 'postgres,bao,shipping,blockchain',
      },
    }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /blockchain/);
});

test("guard: never the land demo's port, nor its API docs port", () => {
  const port = shippingTargetProblems(
    target({settings: {...shipping(), LRFE_HTTP_PORT: '8088'}}),
  );
  assert.equal(port.length, 1);
  assert.match(port[0], /port 8088/);
  const docs = shippingTargetProblems(
    target({
      settings: {
        ...shipping(),
        COMPOSE_PROFILES: 'postgres,bao,shipping,docs',
        LRFE_DOCS_PORT: '3510',
      },
    }),
  );
  assert.equal(docs.length, 1);
  assert.match(docs[0], /port 3510/);
});

test("guard: no compose file that names the land demo's volumes", () => {
  const problems = shippingTargetProblems(
    target({
      composeFiles: [
        {
          file: join(DEMO_DIR, 'compose.keep-volumes.yml'),
          text: readFileSync(
            join(DEMO_DIR, 'compose.keep-volumes.yml'),
            'utf8',
          ),
        },
      ],
    }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /names the land demo's volumes/);
});

test('guard: every problem is named at once', () => {
  const problems = shippingTargetProblems(
    target({
      project: 'lrfe',
      envFile: DEMO_ENV_FILE,
      settings: parseSettings(LAND_ENV),
    }),
  );
  assert.ok(problems.length >= 4, problems.join('; '));
});

// ------------------------------------------------------------------------------ the shipping lock

test('the shipping lock keeps the shipping key store, and names nothing of the land demo', () => {
  const text = readFileSync(
    join(DEMO_DIR, 'compose.keep-volumes.shipping.yml'),
    'utf8',
  );
  assert.match(
    text,
    /bao-data:\s*\n\s+external: true\s*\n\s+name: lrfe-shipping_bao-data/,
  );
  assert.equal(/\blrfe_[a-z-]+/.test(text), false);
  assert.equal(SHIPPING_LOCK_FILE, '../demo/compose.keep-volumes.shipping.yml');
});

// --------------------------------------------------------------------------------------- teardown

test("the rehearsal teardown removes the shipping profiles' containers and volumes too", () => {
  const profiles = REHEARSAL_TEARDOWN_PROFILES.split(',');
  for (const profile of [
    'postgres',
    'bao',
    'bao-setup',
    'shipping',
    'bao-setup-shipping',
  ]) {
    assert.ok(profiles.includes(profile), profile);
  }
  assert.equal(profiles.includes('blockchain'), false);
});

// ------------------------------------------------------------------- CB-49 round 2: review, anchoring

test('the way back after a failed deploy names the same install: --shipping for the shipping demo', () => {
  assert.equal(
    rollbackCommand({
      project: SHIPPING_DEMO.project,
      envFile: SHIPPING_DEMO.envFile,
      version: '0.1.0-old',
    }),
    'node demo/release.mjs deploy --shipping --version 0.1.0-old --mode upgrade',
  );
  assert.equal(
    rollbackCommand({
      project: 'lrfe',
      envFile: DEMO_ENV_FILE,
      version: '0.1.0-old',
    }),
    'node demo/release.mjs deploy --version 0.1.0-old --mode upgrade',
  );
  assert.equal(
    rollbackCommand({
      project: 'lrfe-rehearsal-shipping',
      envFile: '/home/x/rehearsal.env',
      version: '0.1.0-old',
    }),
    'node demo/release.mjs deploy --project lrfe-rehearsal-shipping --env /home/x/rehearsal.env --version 0.1.0-old --mode upgrade',
  );
});

test("the shipping settings: its own bundled database, never the land demo's server or name", () => {
  const base = withSettings(LAND_ENV, {
    POSTGRES_HOST: 'db.example.org',
    POSTGRES_DB: 'land',
    POSTGRES_URL_OPTIONS: '?sslmode=require',
  });
  const settings = parseSettings(
    shippingSettings(base, {
      version: '0.1.0-abc1234',
      port: '8089',
      composeFile: 'docker-compose.yml',
    }),
  );
  assert.equal(settings.POSTGRES_HOST, '');
  assert.equal(settings.POSTGRES_DB, '');
  assert.equal(settings.POSTGRES_URL_OPTIONS, '');
});

test("the shipping settings: anchoring through the relay to the land demo's node, when its network is given", () => {
  const settings = shipping({
    nodeNetwork: 'lrfe_default',
    composeFile: `docker-compose.yml:${SHIPPING_LOCK_FILE}:${SHIPPING_RELAY_FILE}`,
  });
  assert.equal(settings.CARDANO_PROVIDER, 'ogmios');
  assert.equal(settings.CARDANO_NETWORK, 'preview');
  assert.equal(settings.LRFE_NODE_NETWORK, 'lrfe_default');
  assert.equal(settings.TITLE_SIGNER, '');
  const off = shipping();
  assert.equal(off.CARDANO_PROVIDER, '');
  assert.equal(off.LRFE_NODE_NETWORK, '');
});

test("the relay: one container of a name no land service has, on the land node's network, audit through it", () => {
  const text = readFileSync(
    join(DEMO_DIR, 'compose.node-relay.shipping.yml'),
    'utf8',
  );
  assert.equal(SHIPPING_RELAY_FILE, '../demo/compose.node-relay.shipping.yml');
  assert.equal(RELAY_SERVICE, 'shipping-node-relay');
  assert.match(text, /^ {2}shipping-node-relay:$/m);
  assert.match(text, /OGMIOS_URL: http:\/\/shipping-node-relay:1337/);
  assert.match(text, /external: true\s*\n\s+name: \$\{LRFE_NODE_NETWORK:\?/);
  assert.match(text, /TCP:cardano:1337/);
  assert.equal(/\blrfe_[a-z-]+/.test(text), false);
});

test("guard: only the relay joins the land node's network, under its own name", () => {
  const config = networks => ({
    services: Object.fromEntries(
      Object.entries(networks).map(([name, nets]) => [
        name,
        {networks: Object.fromEntries(nets.map(n => [n, null]))},
      ]),
    ),
    networks: {
      default: {name: 'lrfe-shipping_default'},
      'land-node': {name: 'lrfe_default', external: true},
    },
  });
  assert.deepEqual(
    nodeNetworkProblems(
      config({
        audit: ['default'],
        'shipping-node-relay': ['default', 'land-node'],
      }),
      'lrfe_default',
    ),
    [],
  );
  const audit = nodeNetworkProblems(
    config({
      audit: ['default', 'land-node'],
      'shipping-node-relay': ['land-node'],
    }),
    'lrfe_default',
  );
  assert.equal(audit.length, 1);
  assert.match(audit[0], /audit/);
  // the land network under another key is the same network
  const other = nodeNetworkProblems(
    {
      services: {
        web: {networks: {'other-key': null}},
        'shipping-node-relay': {networks: {'land-node': null}},
      },
      networks: {
        'other-key': {name: 'lrfe_default', external: true},
        'land-node': {name: 'lrfe_default', external: true},
      },
    },
    'lrfe_default',
  );
  assert.equal(other.length, 1);
  assert.match(other[0], /web/);
});

test("guard: never the land demo's settings through a link to them", () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipping-guard-'));
  try {
    const real = join(dir, 'land.env');
    writeFileSync(real, LAND_ENV);
    const link = join(dir, '.env.shipping');
    symlinkSync(real, link);
    const problems = shippingTargetProblems(
      target({envFile: link, demoEnvFile: real}),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /the land demo's settings/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('guard: a blockchain profile from the shell is refused too', () => {
  const problems = shippingTargetProblems(
    target({shellProfiles: 'postgres,bao,shipping,blockchain'}),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /COMPOSE_PROFILES/);
  assert.deepEqual(
    shippingTargetProblems(target({shellProfiles: 'postgres,bao,shipping'})),
    [],
  );
});

// -------------------------------------------------------------------- CB-49 round 3: second review

/** A composed configuration with the relay as given and audit on the shipping network. */
function relayConfig(relay) {
  return {
    services: {
      audit: {networks: {default: null}},
      'shipping-node-relay': relay,
    },
    networks: {
      default: {name: 'lrfe-shipping_default'},
      'land-node': {name: 'lrfe_default', external: true},
    },
  };
}

test('guard: the relay has no extra names (aliases) on any network', () => {
  const problems = nodeNetworkProblems(
    relayConfig({
      networks: {default: null, 'land-node': {aliases: ['cardano']}},
    }),
    'lrfe_default',
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /aliases/);
  assert.equal(
    nodeNetworkProblems(
      relayConfig({
        networks: {default: {aliases: ['x']}, 'land-node': null},
      }),
      'lrfe_default',
    ).length,
    1,
  );
});

test('guard: the relay publishes no port', () => {
  const problems = nodeNetworkProblems(
    relayConfig({
      networks: {default: null, 'land-node': null},
      ports: [{target: 1337, published: '1337'}],
    }),
    'lrfe_default',
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /port/);
  assert.deepEqual(
    nodeNetworkProblems(
      relayConfig({networks: {default: null, 'land-node': null}, ports: []}),
      'lrfe_default',
    ),
    [],
  );
});

const LAND_MEMBERS = [
  '/lrfe-audit-1 lrfe-audit-1,audit,61f324e6db94',
  '/lrfe-cardano-1 lrfe-cardano-1,cardano,52a7d6e638f3',
];
const RELAY_MEMBER =
  '/lrfe-shipping-shipping-node-relay-1 lrfe-shipping-shipping-node-relay-1,shipping-node-relay,b20426a092dd';

test('the land network after a shipping step: only the relay, under its own names', () => {
  assert.deepEqual(
    landNetworkProblems(LAND_MEMBERS, [...LAND_MEMBERS, RELAY_MEMBER]),
    [],
  );
  assert.deepEqual(landNetworkProblems(LAND_MEMBERS, LAND_MEMBERS), []);
});

test('the land network: a land container gone, or another container joined, is named', () => {
  const gone = landNetworkProblems(LAND_MEMBERS, [LAND_MEMBERS[1]]);
  assert.equal(gone.length, 1);
  assert.match(gone[0], /^gone: \/lrfe-audit-1/);
  const joined = landNetworkProblems(LAND_MEMBERS, [
    ...LAND_MEMBERS,
    '/lrfe-shipping-audit-1 lrfe-shipping-audit-1,audit,0123456789ab',
  ]);
  assert.ok(joined.length >= 1);
  assert.match(joined[0], /^joined: \/lrfe-shipping-audit-1/);
});

test('the land network: the relay with a land service name or another alias is refused', () => {
  for (const alias of ['cardano', 'audit', 'node']) {
    const problems = landNetworkProblems(LAND_MEMBERS, [
      ...LAND_MEMBERS,
      `${RELAY_MEMBER},${alias}`,
    ]);
    assert.equal(problems.length, 1, alias);
    assert.match(problems[0], new RegExp(`alias ${alias}`));
  }
});

test("the shipping demo's wallet file: a name that cannot be taken for the land demo's", () => {
  assert.match(
    SHIPPING_DEMO.walletFile,
    /\/lrfe-shipping-demo-wallet-address\.txt$/,
  );
  assert.equal(
    SHIPPING_DEMO.walletFile.endsWith('/lrfe-demo-wallet-address.txt'),
    false,
  );
});

test('the relay image is pinned by its digest', () => {
  const text = readFileSync(
    join(DEMO_DIR, 'compose.node-relay.shipping.yml'),
    'utf8',
  );
  assert.match(text, /image: alpine\/socat:[0-9.]+@sha256:[0-9a-f]{64}\n/);
});
