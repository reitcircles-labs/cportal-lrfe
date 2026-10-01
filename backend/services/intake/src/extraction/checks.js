import { docType } from '../doc-types.js';
import { parseExtent, sameName } from './normalize.js';

/**
 * Cross-document checks against the EDRMS: is this instrument already filed, does the prior title
 * it cites exist (and describe the same property, with the transferor among its transferees),
 * does the SG diagram's area match. These are the checks that make "compare during review"
 * reliable; they never depend on the model.
 *
 *   edrms.lookupRef(ref) → document ({ id, edrmsNo, docType, props }) | null
 */
export function createChecker({ edrms }) {
    async function lookup(ref, cache) {
        if (!cache.has(ref)) cache.set(ref, edrms.lookupRef(ref));
        return cache.get(ref);
    }

    return {
        /** Adds checks to `rows` in place. Rows: { k, type, value, normalized, checks }. */
        async check(typeId, rows) {
            const t = docType(typeId);
            if (!t) return;
            const row = (k) => rows.find(r => r.k === k && r.value);
            const cache = new Map();
            const unavailable = (r, err) => r.checks.push({ level: 'warn', code: 'crosscheck_unavailable', message: `Could not check against the EDRMS: ${err.message}` });

            // 1. Already filed?
            const own = t.refField && row(t.refField);
            if (own?.normalized) {
                try {
                    const dup = await lookup(own.normalized, cache);
                    if (dup) own.checks.push({ level: 'error', code: 'duplicate', message: `${own.value} is already filed as ${dup.edrmsNo}`, ref: dup.id });
                } catch (err) { unavailable(own, err); }
            }

            // 2. Prior title: exists, same property, transferor was a holder
            const prior = row('priorTitle');
            if (prior?.normalized) {
                try {
                    const p = await lookup(prior.normalized, cache);
                    if (!p) prior.checks.push({ level: 'warn', code: 'prior_missing', message: `Prior title ${prior.value} is not in the EDRMS yet` });
                    else {
                        prior.checks.push({ level: 'info', code: 'prior_found', message: `Prior title filed as ${p.edrmsNo}`, ref: p.id });
                        const property = row('property');
                        if (property && p.props?.property && !sameName(property.value, p.props.property)) {
                            property.checks.push({ level: 'warn', code: 'prior_property', message: `Prior title ${prior.value} is for “${p.props.property}”` });
                        }
                        // deeds of transfer name a transferor; deeds of sale a seller
                        const transferor = row('transferor') || row('seller1');
                        const holders = Object.entries(p.props || {}).filter(([k]) => /^tee\d$/.test(k)).map(([, v]) => v);
                        if (transferor && holders.length && !holders.some(h => sameName(h, transferor.value))) {
                            transferor.checks.push({ level: 'warn', code: 'chain', message: `Not a holder under ${prior.value} (${holders.join(', ')})` });
                        } else if (transferor && holders.length) {
                            transferor.checks.push({ level: 'info', code: 'chain_ok', message: `Holder under ${prior.value}` });
                        }
                    }
                } catch (err) { unavailable(prior, err); }
            }

            // 3. SG diagram: exists, same area
            const sg = row('sgRef');
            if (sg?.normalized) {
                try {
                    const d = await lookup(sg.normalized, cache);
                    if (!d) sg.checks.push({ level: 'info', code: 'sg_missing', message: `Diagram ${sg.value} is not in the EDRMS yet` });
                    else {
                        sg.checks.push({ level: 'info', code: 'sg_found', message: `Diagram filed as ${d.edrmsNo}`, ref: d.id });
                        const extent = row('extent');
                        const a = extent?.normalized ? Number(extent.normalized) : null;
                        const b = d.props?.extent ? parseExtent(d.props.extent) : null;
                        if (a != null && b != null && Math.abs(a - b) > Math.max(1, b * 0.005)) {
                            extent.checks.push({ level: 'warn', code: 'extent_mismatch', message: `Diagram ${sg.value} gives ${d.props.extent}` });
                        }
                    }
                } catch (err) { unavailable(sg, err); }
            }
        }
    };
}

/** A checker that checks nothing (no EDRMS configured, and tests that don't need it). */
export const noChecks = { async check() {} };
