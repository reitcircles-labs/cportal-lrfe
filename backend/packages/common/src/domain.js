import {checkDomainPack, isPackName} from '@lrfe/domain-pack';

import {env} from './config.js';

/** The pack an install uses when `LRFE_DOMAIN` is not set: existing installs need no change. */
export const DEFAULT_DOMAIN = 'land';

/**
 * Loads and checks the domain pack of a name (CB-3): the workspace package `@lrfe/domain-<name>`
 * (`backend/domains/<name>`), which exports it as `pack`. A pack that is missing or cannot be used fails here, at start.
 * @param {string} name e.g. `land`, `shipping`
 * @return {Promise<import('@lrfe/domain-pack').DomainPack>}
 */
export async function loadDomainPack(name) {
  if (!isPackName(name)) {
    throw new Error(
      `LRFE_DOMAIN must be a pack name (lower-case letters, digits, dashes), got "${name}"`,
    );
  }
  let module;
  try {
    module = await import(`@lrfe/domain-${name}`);
  } catch (err) {
    throw new Error(`No domain pack "${name}": ${err.message}`);
  }
  return checkDomainPack(module.pack, name);
}

/**
 * The domain pack of this install, chosen by `LRFE_DOMAIN` (`land` by default), loaded once for
 * every service: the shared services take their product's document types, roles, workflows,
 * record kind and wording from here, never from code of their own.
 * @type {import('@lrfe/domain-pack').DomainPack}
 */
export const domain = await loadDomainPack(env('LRFE_DOMAIN', DEFAULT_DOMAIN));

/**
 * The product's record service (CB-4): the service that answers the record contract
 * (`@lrfe/record-contract`), as the pack names it, with its address from its setting
 * (`RECORDS_URL` for land). Null when the pack has no records (the shipping pack today).
 * @param {import('@lrfe/domain-pack').DomainPack} pack
 * @return {{name: string, label: string, url: string} | null}
 */
export function recordServiceOf(pack) {
  const service = pack.recordKind?.service;
  if (!service) {
    return null;
  }
  return {
    name: service.name,
    label: service.label,
    url: env(service.urlSetting, service.defaultUrl),
  };
}
