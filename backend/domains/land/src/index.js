import {documents} from './documents.js';
import {identity} from './identity.js';
import {recordKind} from './record-kind.js';
import {wording} from './wording/index.js';
import {workflows} from './workflows.js';

/**
 * The land registry's domain pack (CB-3): what the shared services know about land records. It
 * maps to the names already stored or anchored by existing installs (`land-records`, `records.*`,
 * `record:<id>`, `land-record-review`, role and document-type ids, leaf type 1); they never change
 * (docs/architecture/products.md, "What may never change").
 * @type {import('@lrfe/domain-pack').DomainPack}
 */
export const pack = {
  name: 'land',
  documents,
  identity,
  workflows,
  recordKind,
  wording,
};
