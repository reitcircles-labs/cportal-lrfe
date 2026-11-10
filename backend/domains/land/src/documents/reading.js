import {parseExtent, sameName} from './field-types.js';

/**
 * How intake reads land-registry instruments (CB-3; before, in intake's extraction/prompt.js,
 * checks.js, crosscheck.js and pipeline.js): what the reading prompt says about the documents, the
 * checks between the fields of one document, and the checks against documents already filed.
 */

/**
 * The prompt's version, stored with every extraction for traceability. Bump it whenever the prompt
 * or the document types change.
 */
const PROMPT_VERSION = 'lr-extract-2026-10-03.1'; // marital regime: whose (API-621); 09-29.2: deed of sale

/** What intake's reading prompt says about land-registry documents. */
const prompt = {
  subject:
    'scanned instruments from the Deeds Registry of the Republic of Namibia (deeds of transfer, deeds of sale, deeds of grant, Surveyor-General diagrams, mortgage bonds and supporting documents)',
  languages: 'English, Afrikaans or German',
  notOfKind: 'a land-registry instrument',
  rules: ['Parties are numbered in the order they appear (tee1, tee2, …).'],
};

/**
 * Checks between the fields of one document, added to its rows in place. A purchase price equal to
 * the deposit is usually the deposit read into the wrong field.
 * @param {string} typeId the document type
 * @param {Array<object>} rows the review rows `{k, normalized, checks, …}`
 */
function checkRows(typeId, rows) {
  const price = rows.find(r => r.k === 'price' && r.normalized);
  const deposit = rows.find(r => r.k === 'deposit' && r.normalized);
  if (
    price &&
    deposit &&
    price.normalized === deposit.normalized &&
    typeId === 'deed_of_sale'
  ) {
    price.checks.push({
      level: 'warn',
      code: 'same_as_deposit',
      message:
        'Same amount as the deposit; check that this is the full purchase price',
    });
  }
}

/**
 * Checks against the EDRMS, after intake's own "already filed?": does the prior title a document
 * cites exist (and describe the same property, with the transferor among its transferees), does
 * the SG diagram's area match. They never depend on the model.
 *
 * `check` adds them to the rows in place, with what intake gives it (also `typeId` and `rows`):
 *   row(k)              the row of field k, when it has a value
 *   lookup(ref)         the filed document ({id, edrmsNo, docType, props}) with that reference, or null
 *   unavailable(r, err) notes on row r that the EDRMS could not be asked
 */
const crossChecks = {
  /** The codes of the checks below, removed before the checks run again. */
  codes: [
    'prior_missing',
    'prior_found',
    'prior_property',
    'chain',
    'chain_ok',
    'sg_missing',
    'sg_found',
    'extent_mismatch',
  ],

  /**
   * @param {{row: function(string): ?object, lookup: function(string): Promise<?object>,
   *     unavailable: function(object, Error): void}} context
   */
  async check({row, lookup, unavailable}) {
    await checkPriorTitle({row, lookup, unavailable});
    await checkDiagram({row, lookup, unavailable});
  },
};

/**
 * Prior title: exists, same property, transferor was a holder.
 * @param {object} context see crossChecks
 */
async function checkPriorTitle({row, lookup, unavailable}) {
  const prior = row('priorTitle');
  if (!prior?.normalized) {
    return;
  }
  try {
    const p = await lookup(prior.normalized);
    if (!p) {
      prior.checks.push({
        level: 'warn',
        code: 'prior_missing',
        message: `Prior title ${prior.value} is not in the EDRMS yet`,
      });
      return;
    }
    prior.checks.push({
      level: 'info',
      code: 'prior_found',
      message: `Prior title filed as ${p.edrmsNo}`,
      ref: p.id,
    });
    const property = row('property');
    if (
      property &&
      p.props?.property &&
      !sameName(property.value, p.props.property)
    ) {
      property.checks.push({
        level: 'warn',
        code: 'prior_property',
        message: `Prior title ${prior.value} is for “${p.props.property}”`,
      });
    }
    // deeds of transfer name a transferor; deeds of sale a seller
    const transferor = row('transferor') || row('seller1');
    const holders = Object.entries(p.props || {})
      .filter(([k]) => /^tee\d$/.test(k))
      .map(([, v]) => v);
    if (
      transferor &&
      holders.length &&
      !holders.some(h => sameName(h, transferor.value))
    ) {
      transferor.checks.push({
        level: 'warn',
        code: 'chain',
        message: `Not a holder under ${prior.value} (${holders.join(', ')})`,
      });
    } else if (transferor && holders.length) {
      transferor.checks.push({
        level: 'info',
        code: 'chain_ok',
        message: `Holder under ${prior.value}`,
      });
    }
  } catch (err) {
    unavailable(prior, err);
  }
}

/**
 * SG diagram: exists, same area.
 * @param {object} context see crossChecks
 */
async function checkDiagram({row, lookup, unavailable}) {
  const sg = row('sgRef');
  if (!sg?.normalized) {
    return;
  }
  try {
    const d = await lookup(sg.normalized);
    if (!d) {
      sg.checks.push({
        level: 'info',
        code: 'sg_missing',
        message: `Diagram ${sg.value} is not in the EDRMS yet`,
      });
      return;
    }
    sg.checks.push({
      level: 'info',
      code: 'sg_found',
      message: `Diagram filed as ${d.edrmsNo}`,
      ref: d.id,
    });
    const extent = row('extent');
    const a = extent?.normalized ? Number(extent.normalized) : null;
    const b = d.props?.extent ? parseExtent(d.props.extent) : null;
    if (a != null && b != null && Math.abs(a - b) > Math.max(1, b * 0.005)) {
      extent.checks.push({
        level: 'warn',
        code: 'extent_mismatch',
        message: `Diagram ${sg.value} gives ${d.props.extent}`,
      });
    }
  } catch (err) {
    unavailable(sg, err);
  }
}

/** How intake reads land-registry instruments. */
export const reading = {
  promptVersion: PROMPT_VERSION,
  prompt,
  checkRows,
  crossChecks,
  // the example the automatic cross-check gives of a value that belongs to someone else
  wrongPartyExample:
    'e.g. the seller instead of the buyer, or the deceased instead of the heirs',
};
