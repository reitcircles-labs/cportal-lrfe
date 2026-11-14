#!/usr/bin/env node
/**
 * Creates every service's schema and tables in one step, before the services start (API-711):
 *
 *   npm run db:setup        in backend/, with DB_CONNECTION_STRING set for the database to set up
 *
 * The containers run it as the one-shot service db-setup (deploy/docker-compose.yml); the services
 * start once it has finished and run with DB_SYNC=false. Without containers it sets up any
 * PostgreSQL database the same way, also one a DBA has prepared (schemas created first for a less
 * privileged user: README.md). Safe to run again: on a set-up database it only adds what is missing
 * and keeps the data. Waits for the database to answer for up to DB_SETUP_WAIT_SECONDS (120).
 */
import {env, envInt, setUpDatabase} from '@lrfe/common';
import {createSequelizeRepo as audit} from '../services/audit/src/repo/sequelize.js';
import {SCHEMA as AUDIT} from '../services/audit/src/repo/models.js';
import {createSequelizeRepo as bpm} from '../services/bpm/src/repo/sequelize.js';
import {SCHEMA as BPM} from '../services/bpm/src/repo/models.js';
import {createSequelizeRepo as edrms} from '../services/edrms/src/repo/sequelize.js';
import {SCHEMA as EDRMS} from '../services/edrms/src/repo/models.js';
import {createSequelizeRepo as extracts} from '../services/extracts/src/repo/sequelize.js';
import {SCHEMA as EXTRACTS} from '../services/extracts/src/repo/models.js';
import {createSequelizeRepo as identity} from '../services/identity/src/repo/sequelize.js';
import {SCHEMA as IDENTITY} from '../services/identity/src/repo/models.js';
import {createSequelizeRepo as intake} from '../services/intake/src/repo/sequelize.js';
import {SCHEMA as INTAKE} from '../services/intake/src/repo/models.js';
import {createSequelizeRepo as landRecords} from '../services/land-records/src/repo/sequelize.js';
import {SCHEMA as RECORDS} from '../services/land-records/src/repo/models.js';
import {createSequelizeRepo as shippingRecords} from '../services/shipping-records/src/repo/sequelize.js';
import {SCHEMA as SHIPPING_RECORDS} from '../services/shipping-records/src/repo/models.js';

const SERVICES = [
  {name: 'identity', schema: IDENTITY, createRepo: identity},
  {name: 'edrms', schema: EDRMS, createRepo: edrms},
  {name: 'bpm', schema: BPM, createRepo: bpm},
  {name: 'intake', schema: INTAKE, createRepo: intake},
  {name: 'land-records', schema: RECORDS, createRepo: landRecords},
  {
    name: 'shipping-records',
    schema: SHIPPING_RECORDS,
    createRepo: shippingRecords,
    domain: 'shipping',
  },
  {name: 'audit', schema: AUDIT, createRepo: audit},
  {name: 'extracts', schema: EXTRACTS, createRepo: extracts},
];

/**
 * What to do about the two mistakes a site most likely makes in .env, or nothing. Never repeats the
 * database address: it holds the password.
 * @param {!Error} error
 * @return {string}
 */
function hintFor(error) {
  let root = error;
  while (root.cause) root = root.cause;
  const code = root.original?.code ?? root.code;
  if (code === 'ERR_INVALID_URL') {
    return (
      'The database address is not valid: check the POSTGRES_* settings in .env. A password with ' +
      'characters other than letters and digits must be percent-encoded (README.md).'
    );
  }
  if (
    (code === 'ENOTFOUND' || code === 'EAI_AGAIN') &&
    root.original?.hostname === 'postgres'
  ) {
    return (
      'The bundled database is not running: add postgres to COMPOSE_PROFILES in .env, or set ' +
      'POSTGRES_HOST to an existing server (README.md).'
    );
  }
  return '';
}

/** The product of this install (CB-3): land when not set. */
const DOMAIN = env('LRFE_DOMAIN', 'land');

/**
 * The services whose schema this install sets up: every shared service and land-records (present
 * on every install), and a product's own record service only on that product's installs, so that a
 * land install's database stays exactly as it was (CB-28 rehearsal).
 * @type {!Array<{name: string, schema: string, createRepo: function, domain: (string|undefined)}>}
 */
const SERVICES_OF_INSTALL = SERVICES.filter(
  service => service.domain === undefined || service.domain === DOMAIN,
);

const log = message => console.log(`db-setup: ${message}`);
try {
  await setUpDatabase(SERVICES_OF_INSTALL, {
    wait: {timeoutMs: envInt('DB_SETUP_WAIT_SECONDS', 120) * 1000},
    log,
  });
  log('done');
} catch (error) {
  console.error(`db-setup: failed: ${error.message}`);
  const hint = hintFor(error);
  if (hint) console.error(`db-setup: ${hint}`);
  process.exit(1);
}
