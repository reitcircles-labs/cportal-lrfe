import {readFileSync} from 'node:fs';

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import yaml from 'js-yaml';

/** DCSA's B/L specification the model follows (copied unchanged, see dcsa/3.0.3/SOURCE.md). */
const SPEC_URL = new URL(
  '../../dcsa/3.0.3/DCSA_EBL-3.0.3.yaml',
  import.meta.url,
);

/**
 * The fields of DCSA's TransportDocument that are not part of the stored document
 * (docs/dcsa-field-map.md): the status belongs to the title engine, feedbacks are API messages.
 */
export const LEFT_OUT_FIELDS = Object.freeze([
  'transportDocumentStatus',
  'feedbacks',
]);

/**
 * OpenAPI 3.0 writes `exclusiveMinimum: true` next to `minimum` (JSON Schema draft 4); the
 * validator expects the number itself (draft 6 and later). Rewrites the schemas in place.
 *
 * @param {*} node a schema or part of one
 */
function toCurrentBounds(node) {
  if (!node || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach(toCurrentBounds);
    return;
  }
  for (const [flag, bound] of [
    ['exclusiveMinimum', 'minimum'],
    ['exclusiveMaximum', 'maximum'],
  ]) {
    if (typeof node[flag] === 'boolean') {
      if (node[flag]) {
        node[flag] = node[bound];
        delete node[bound];
      } else {
        delete node[flag];
      }
    }
  }
  for (const value of Object.values(node)) {
    toCurrentBounds(value);
  }
}

let validator = null;

/**
 * The check of a document against DCSA's TransportDocument schema, without the left-out fields:
 * every required field, type, length, pattern and code list DCSA defines. Built on first use (the
 * specification is large) and kept.
 *
 * @return {import('ajv').ValidateFunction} the compiled check; its `errors` after a failed call
 */
export function transportDocumentValidator() {
  if (validator) {
    return validator;
  }
  const spec = yaml.load(readFileSync(SPEC_URL, 'utf8'));
  const schemas = structuredClone(spec.components.schemas);
  toCurrentBounds(schemas);
  const document = schemas.TransportDocument;
  for (const field of LEFT_OUT_FIELDS) {
    delete document.properties[field];
  }
  document.required = document.required.filter(
    f => !LEFT_OUT_FIELDS.includes(f),
  );
  // DCSA's schemas carry OpenAPI words (`example`, `discriminator`) the validator does not know.
  const ajv = new Ajv({strict: false, allErrors: true});
  addFormats(ajv);
  ajv.addSchema({$id: 'dcsa-ebl-3.0', components: {schemas}});
  validator = ajv.getSchema(
    'dcsa-ebl-3.0#/components/schemas/TransportDocument',
  );
  return validator;
}
