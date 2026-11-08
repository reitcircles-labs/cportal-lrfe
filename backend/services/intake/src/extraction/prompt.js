import {domain} from '@lrfe/common';
import {allFieldKeysOf, docTypesOf} from '../doc-types.js';

/**
 * The reading prompt and the schema of the model's answer, made from the product's document types
 * and what its domain pack says about them (`documents.reading`, CB-3).
 */

/**
 * The prompt's version, stored with every extraction for traceability: the domain pack's, which
 * it bumps whenever its prompt texts or document types change.
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {?string}
 */
export function promptVersionOf(pack = domain) {
  return pack.documents.reading?.promptVersion ?? null;
}

/** The prompt version of this install's product. */
export const PROMPT_VERSION = promptVersionOf();

/**
 * The instruction sent with each document. Generated from the pack's document types.
 * @param {{transcribe?: boolean}=} options
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {string}
 */
export function buildPrompt({transcribe = true} = {}, pack = domain) {
  const about = pack.documents.reading?.prompt ?? {};
  const subject = about.subject ?? 'scanned documents';
  const notOfKind = about.notOfKind ?? 'one of the document types below';
  const types = docTypesOf(pack)
    .map(t =>
      [
        `### ${t.id} — ${t.label}`,
        t.desc,
        ...t.fields.map(
          x => `- ${x.k}${x.required ? ' (required)' : ''}: ${x.desc}`,
        ),
      ].join('\n'),
    )
    .join('\n\n');
  const rules = [
    `Classify the whole document as exactly one docType. Use "unknown" only if it is not ${notOfKind} or is unreadable.`,
    'Extract only the fields listed for that docType. Omit a field that is not present — never guess or infer a value.',
    'Copy each value exactly as written: keep the original spelling, language, punctuation and digits. Do not translate, correct, reformat or complete anything. If an ID number looks too short or too long, copy it anyway.',
    'Where a value was corrected by hand on the document, give the corrected (final) value.',
    '"page" is the 1-based page number where the value appears. "evidence" is a short verbatim quote (a few words) from that page that contains the value.',
    'Set "legible" to false if you are unsure of any character of the value.',
    ...(about.rules ?? []),
    transcribe
      ? 'In "pages", transcribe every page completely in reading order as plain text, one entry per page.'
      : 'Return "pages" as an empty list.',
  ];
  const languages = about.languages ? `, and may be in ${about.languages}` : '';

  return `You read ${subject} and return their metadata as JSON.

The documents may be old, faded, partly handwritten, or hand-corrected${languages}.

Rules:
${rules.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}

Document types and their fields:

${types}`;
}

/**
 * JSON schema for the answer (the subset Gemini's structured output supports).
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {object}
 */
export function buildResponseSchema(pack = domain) {
  const fieldKeys = allFieldKeysOf(pack);
  // a list of no values is not a valid schema (a pack without document types)
  const fieldKeySchema = fieldKeys.length
    ? {type: 'string', enum: fieldKeys}
    : {type: 'string'};
  return {
    type: 'object',
    properties: {
      docType: {
        type: 'string',
        enum: [...docTypesOf(pack).map(t => t.id), 'unknown'],
      },
      docTypeReason: {
        type: 'string',
        description: 'One sentence: why this document type',
      },
      languages: {
        type: 'array',
        items: {type: 'string'},
        description:
          'ISO 639-1 codes of the languages used, e.g. ["en"] or ["af", "en"]',
      },
      handwritingPresent: {type: 'boolean'},
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            k: fieldKeySchema,
            value: {type: 'string'},
            page: {type: 'integer', minimum: 1},
            evidence: {type: 'string'},
            legible: {type: 'boolean'},
          },
          required: ['k', 'value', 'page', 'evidence', 'legible'],
        },
      },
      pages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            page: {type: 'integer', minimum: 1},
            text: {type: 'string'},
          },
          required: ['page', 'text'],
        },
      },
    },
    required: ['docType', 'languages', 'handwritingPresent', 'fields', 'pages'],
  };
}
