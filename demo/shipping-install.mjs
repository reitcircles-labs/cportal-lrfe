/**
 * The shipping demo install (CB-49): a second demo install, for the shipping product, beside the
 * land registry's (compose project lrfe, port 8088), with its own project, port, data and key store.
 * Its settings and the guards that keep it away from the land demo; demo/release.mjs does the rest.
 */
import {randomBytes} from 'node:crypto';
import {existsSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const DEPLOY = join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy');

/** The land demo's settings file: never a shipping install's. */
export const DEMO_ENV_FILE = join(DEPLOY, '.env');

/** The projects a shipping install never is: the land demo and its rehearsal. */
const LAND_PROJECTS = ['lrfe', 'lrfe-rehearsal'];

/**
 * The land demo's ports when its settings cannot be read (a checkout other than the demo's): the
 * web app's and the API docs'.
 */
export const LAND_DEMO_PORTS = {http: '8088', docs: '3510'};

/**
 * The compose file that keeps the shipping demo's key store (its title signing key): declared
 * external, so compose never deletes it. Relative to deploy/, as COMPOSE_FILE has it.
 */
export const SHIPPING_LOCK_FILE = '../demo/compose.keep-volumes.shipping.yml';

/**
 * The compose file of the relay to the land demo's blockchain node (CB-49), relative to deploy/:
 * the only part of a shipping install on the land demo's network.
 */
export const SHIPPING_RELAY_FILE = '../demo/compose.node-relay.shipping.yml';

/** The relay's service name: no land service has it. */
export const RELAY_SERVICE = 'shipping-node-relay';

/** The shipping demo install. */
export const SHIPPING_DEMO = {
  project: 'lrfe-shipping',
  port: '8089',
  envFile: join(DEPLOY, '.env.shipping'),
  /** OpenBao's unseal key and root token, this user only (as ~/lrfe-demo-openbao-init.json). */
  initFile: join(homedir(), 'lrfe-shipping-openbao-init.json'),
  /**
   * Its anchoring wallet's public address, to fund it with test ADA; not the land demo's
   * (`~/lrfe-demo-wallet-address.txt`).
   */
  walletFile: join(homedir(), 'lrfe-shipping-demo-wallet-address.txt'),
};

/** The shipping demo's throwaway rehearsal install: removed after the rehearsal. */
export const SHIPPING_REHEARSAL = {
  project: 'lrfe-rehearsal-shipping',
  port: '8717',
  /** Its settings, OpenBao keys and seal folder, this user only. */
  dir: join(homedir(), '.lrfe-rehearsal-shipping'),
};

/**
 * Every profile a rehearsal install may run, the shipping product's included: `down -v` with all
 * of them removes all its containers and volumes.
 */
export const REHEARSAL_TEARDOWN_PROFILES =
  'postgres,bao,bao-setup,shipping,bao-setup-shipping';

/** The secrets a shipping install gets new, never the land demo's. */
const NEW_SECRETS = [
  'JWT_SECRET',
  'POSTGRES_PASSWORD',
  'SEED_DEMO_PASSWORD',
  'BOOTSTRAP_ADMIN_PASSWORD',
];

/** The land demo's database server and name: a shipping install has its own bundled one. */
const LAND_DATABASE = {
  POSTGRES_HOST: '',
  POSTGRES_DB: '',
  POSTGRES_URL_OPTIONS: '',
};

/** The land registry's organisation texts: a shipping install has the pack's (CB-48). */
const LAND_ORGANISATION = [
  'LRFE_ORG_NAME',
  'LRFE_ORG_SUBTITLE',
  'LRFE_ORG_PARENT',
  'LRFE_ORG_PLACE',
];

/**
 * A new secret: 48 random bytes, URL-safe, so it fits a database address unchanged.
 * @return {string}
 */
export function newSecret() {
  return randomBytes(48).toString('base64url');
}

/**
 * The settings of a settings file, read the way docker compose reads them.
 * @param {string} text the file's text
 * @return {!Object<string, string>}
 */
export function parseSettings(text) {
  const settings = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').replace(/^\s*export\s+/, '');
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const quoted = /^(['"])(.*)\1\s*(#.*)?$/.exec(match[2]);
    if (quoted) {
      settings[match[1]] = quoted[2];
    } else {
      settings[match[1]] = match[2].replace(/\s+#.*$/, '').trim();
    }
  }
  return settings;
}

/**
 * The settings file with `values` set: each line replaced in place, or added at the end.
 * @param {string} text the file's text
 * @param {!Object<string, string>} values the settings to set
 * @return {string}
 */
export function withSettings(text, values) {
  const lines = text.split('\n');
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const name = /^\s*(?:export\s+)?([A-Za-z0-9_]+)=/.exec(lines[i])?.[1];
    if (name && name in values) {
      lines[i] = `${name}=${values[name]}`;
      seen.add(name);
    }
  }
  const added = Object.keys(values).filter(name => !seen.has(name));
  while (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return [...lines, ...added.map(name => `${name}=${values[name]}`), ''].join(
    '\n',
  );
}

/**
 * The settings file without these settings.
 * @param {string} text the file's text
 * @param {!Array<string>} names the settings to remove
 * @return {string}
 */
function withoutSettings(text, names) {
  return text
    .split('\n')
    .filter(line => {
      const name = /^\s*(?:export\s+)?([A-Za-z0-9_]+)=/.exec(line)?.[1];
      return !names.includes(name);
    })
    .join('\n');
}

/**
 * A shipping install's settings, made from another install's (the land demo's: mail, sign-in and
 * time zone known to work on this server). New secrets; the shipping product and its profile; its
 * own bundled database; no AI, document check, shared bucket or search directory; the seal off;
 * the title signer off until OpenBao is prepared for it. Anchoring (CB-49) through the relay to the
 * land demo's node when `nodeNetwork` (that node's network) is given, else off.
 * @param {string} baseText the other install's settings file
 * @param {{version: string, port: string, composeFile: string, nodeNetwork: (?string|undefined)}}
 *     install the shipping install
 * @return {string} the shipping install's settings file
 */
export function shippingSettings(
  baseText,
  {version, port, composeFile, nodeNetwork = null},
) {
  const secrets = {};
  for (const name of NEW_SECRETS) {
    secrets[name] = newSecret();
  }
  return withSettings(withoutSettings(baseText, LAND_ORGANISATION), {
    LRFE_VERSION: version,
    LRFE_DOMAIN: 'shipping',
    COMPOSE_PROFILES: 'postgres,bao,shipping',
    COMPOSE_FILE: composeFile,
    LRFE_HTTP_PORT: port,
    LRFE_PUBLIC_URL: `http://localhost:${port}`,
    LRFE_OFFICES: '',
    ...LAND_DATABASE,
    ...secrets,
    EXTRACTION_PROVIDER: 'mock',
    GEMINI_API_KEY: '',
    JEV_ENABLED: 'false',
    TYPESAFE_API_KEY: '',
    EDRMS_STORAGE: 'local',
    AWS_BUCKET_NAME: '',
    AWS_BUCKET_REGION: '',
    AWS_ACCESS_KEY_ID: '',
    AWS_SECRET_ACCESS_KEY: '',
    OPENSEARCH_DATA_DIR: '',
    CARDANO_PROVIDER: nodeNetwork ? 'ogmios' : '',
    LRFE_NODE_NETWORK: nodeNetwork ?? '',
    LRFE_SEAL: '',
    LRFE_SEAL_CERT: '',
    TITLE_SIGNER: '',
  });
}

/**
 * Why a shipping install must not be changed as given: an empty list when it may.
 * @param {{
 *   project: string,
 *   envFile: string,
 *   settings: !Object<string, string>,
 *   composeFiles: !Array<{file: string, text: string}>,
 *   demoSettings: !Object<string, string>,
 *   demoEnvFile: (string|undefined),
 *   shellProfiles: (string|undefined),
 * }} target the install, its settings and compose files, the land demo's settings and their
 *     file, and the shell's COMPOSE_PROFILES (which compose takes over the settings file's)
 * @return {!Array<string>}
 */
export function shippingTargetProblems({
  project,
  envFile,
  settings,
  composeFiles,
  demoSettings,
  demoEnvFile = DEMO_ENV_FILE,
  shellProfiles,
}) {
  const problems = [];
  if (LAND_PROJECTS.includes(project)) {
    problems.push(
      `project ${project} is the land registry's; a shipping install has its own`,
    );
  }
  if (realPath(envFile) === realPath(demoEnvFile)) {
    problems.push(
      `${envFile} is the land demo's settings; a shipping install has its own`,
    );
  }
  const profiles = (settings.COMPOSE_PROFILES || '')
    .split(',')
    .map(profile => profile.trim());
  if (settings.LRFE_DOMAIN !== 'shipping') {
    problems.push('a shipping install needs LRFE_DOMAIN=shipping');
  }
  if (!profiles.includes('shipping')) {
    problems.push('a shipping install needs the profile shipping');
  }
  const shell = (shellProfiles ?? '').split(',').map(profile => profile.trim());
  if (shell.includes('blockchain')) {
    problems.push(
      "the shell's COMPOSE_PROFILES names the profile blockchain (compose would take it over the settings file's): unset it",
    );
  }
  if (profiles.includes('blockchain')) {
    problems.push(
      "the profile blockchain would start a second blockchain node beside the land demo's: ask the user how the shipping install anchors",
    );
  }
  const demoPort = demoSettings.LRFE_HTTP_PORT || LAND_DEMO_PORTS.http;
  if (settings.LRFE_HTTP_PORT === demoPort) {
    problems.push(`port ${demoPort} is the land demo's`);
  }
  const demoDocsPort = demoSettings.LRFE_DOCS_PORT || LAND_DEMO_PORTS.docs;
  if (
    profiles.includes('docs') &&
    (settings.LRFE_DOCS_PORT || LAND_DEMO_PORTS.docs) === demoDocsPort
  ) {
    problems.push(`port ${demoDocsPort} is the land demo's API docs`);
  }
  const naming = composeFiles
    .filter(({text}) => /\blrfe_[a-z-]+/.test(text))
    .map(({file}) => file);
  if (naming.length) {
    problems.push(
      `a compose file names the land demo's volumes: ${naming.join(', ')}`,
    );
  }
  return problems;
}

/**
 * A path with its links followed, when it exists; as written (made absolute) when it does not.
 * @param {string} path
 * @return {string}
 */
function realPath(path) {
  if (existsSync(path)) {
    return realpathSync(path);
  }
  return resolve(path);
}

/**
 * The command that puts an install back on an earlier version, after a deploy that failed: the
 * same install it was meant for.
 * @param {{project: string, envFile: string, version: string}} install the install and the version
 * @return {string}
 */
export function rollbackCommand({project, envFile, version}) {
  const tail = `--version ${version} --mode upgrade`;
  if (project === SHIPPING_DEMO.project) {
    return `node demo/release.mjs deploy --shipping ${tail}`;
  }
  if (project === 'lrfe' && realPath(envFile) === realPath(DEMO_ENV_FILE)) {
    return `node demo/release.mjs deploy ${tail}`;
  }
  return `node demo/release.mjs deploy --project ${project} --env ${envFile} ${tail}`;
}

/**
 * Why a shipping install's composed configuration (`docker compose config --format json`) would
 * put more than the relay on the land node's network: an empty list when only the relay joins it.
 * @param {{services: !Object<string, {networks: ?Object}>, networks: !Object<string, {name: string}>}}
 *     config the composed configuration
 * @param {string} landNetwork the land demo's network that holds its node
 * @return {!Array<string>}
 */
export function nodeNetworkProblems(config, landNetwork) {
  const landKeys = Object.entries(config.networks ?? {})
    .filter(([, network]) => network?.name === landNetwork)
    .map(([key]) => key);
  const problems = [];
  for (const [name, service] of Object.entries(config.services ?? {})) {
    const joins = Object.keys(service.networks ?? {}).some(key =>
      landKeys.includes(key),
    );
    if (joins && name !== RELAY_SERVICE) {
      problems.push(
        `the service ${name} would join the land demo's network ${landNetwork}: only ${RELAY_SERVICE} may`,
      );
    }
  }
  const relay = config.services?.[RELAY_SERVICE];
  if (relay) {
    // its own name only: an alias could answer for a land service on the land network
    const aliased = Object.entries(relay.networks ?? {})
      .filter(([, network]) => (network?.aliases ?? []).length > 0)
      .map(([key, network]) => `${key}: ${network.aliases.join(', ')}`);
    if (aliased.length) {
      problems.push(
        `${RELAY_SERVICE} must have no aliases (${aliased.join('; ')})`,
      );
    }
    if ((relay.ports ?? []).length > 0) {
      problems.push(
        `${RELAY_SERVICE} must publish no port: the node stays off the host`,
      );
    }
  }
  return problems;
}

/**
 * Why the land demo's network after a shipping step is not as it was plus the relay: an empty list
 * when it is. Each member is a line of `<container name> <its aliases there, comma-separated>`
 * (release.mjs, landNetworkMembers). The relay may join under its container name, its service name
 * and its short id only, never under any other name.
 * @param {!Array<string>} before the members before the step
 * @param {!Array<string>} after the members after it
 * @return {!Array<string>}
 */
export function landNetworkProblems(before, after) {
  const problems = before
    .filter(member => !after.includes(member))
    .map(member => `gone: ${member}`);
  for (const member of after.filter(line => !before.includes(line))) {
    problems.push(...joinedProblems(member));
  }
  return problems;
}

/**
 * Why a container that joined the land demo's network may not be there: none for the relay
 * under its own names.
 * @param {string} member the member's line: its container name and its aliases
 * @return {!Array<string>}
 */
function joinedProblems(member) {
  const [slashName, aliasList = ''] = member.split(' ');
  const name = slashName.replace(/^\//, '');
  if (!name.endsWith(`-${RELAY_SERVICE}-1`)) {
    return [`joined: ${member}`];
  }
  const own = [name, RELAY_SERVICE];
  return aliasList
    .split(',')
    .filter(
      alias => alias && !own.includes(alias) && !/^[0-9a-f]{12}$/.test(alias),
    )
    .map(
      alias => `the relay ${name} has the alias ${alias} on the land network`,
    );
}
