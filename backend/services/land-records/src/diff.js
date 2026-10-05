import { normalizeSearch } from '@lrfe/common';

/**
 * What a version changes against the current committed one (README.md section 6), for the
 * reviewer: core fields (path, before, after), owners and shares, documents added, removed or
 * moved to a newer EDRMS version. `before` null: the first version, everything is new.
 */
export function diffVersions(before, after) {
    const b = before || {}, a = after || {};
    const fields = [];
    const strip = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'source')) : v);
    const walk = (path, x, y) => {
        if (JSON.stringify(x) === JSON.stringify(y)) return;
        const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
        if (isObj(x) && isObj(y)) {
            for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) walk(`${path}.${k}`, x[k], y[k]);
            return;
        }
        fields.push({ path, before: x ?? null, after: y ?? null });
    };
    for (const k of ['parcel', 'extent', 'tenure', 'attributes']) walk(k, strip(b[k]), strip(a[k]));

    const key = (o) => normalizeSearch(o.name);
    const oldOwners = new Map((b.owners || []).map(o => [key(o), o])), newOwners = new Map((a.owners || []).map(o => [key(o), o]));
    const owners = {
        added: [...newOwners].filter(([k]) => !oldOwners.has(k)).map(([, o]) => ({ name: o.name, share: o.share, idNo: o.idNo ?? null })),
        removed: [...oldOwners].filter(([k]) => !newOwners.has(k)).map(([, o]) => ({ name: o.name, share: o.share, idNo: o.idNo ?? null })),
        changed: [...newOwners].filter(([k, o]) => oldOwners.has(k) && (oldOwners.get(k).share !== o.share || (oldOwners.get(k).idNo ?? null) !== (o.idNo ?? null)))
            .map(([k, o]) => ({ name: o.name, before: { share: oldOwners.get(k).share, idNo: oldOwners.get(k).idNo ?? null }, after: { share: o.share, idNo: o.idNo ?? null } }))
    };

    const encKey = (e) => `${e.type}:${normalizeSearch(e.ref)}`;
    const oldEnc = new Set((b.encumbrances || []).map(encKey));
    const newEnc = new Set((a.encumbrances || []).map(encKey));
    const encumbrances = {
        added: (a.encumbrances || []).filter(e => !oldEnc.has(encKey(e))),
        removed: (b.encumbrances || []).filter(e => !newEnc.has(encKey(e)))
    };

    const brief = (d) => ({ edrmsDocumentId: d.edrmsDocumentId, edrmsNo: d.edrmsNo, ref: d.ref ?? null, docType: d.docType, version: d.version });
    const oldDocs = new Map((b.documents || []).map(d => [d.edrmsDocumentId, d])), newDocs = new Map((a.documents || []).map(d => [d.edrmsDocumentId, d]));
    const documents = {
        added: [...newDocs.values()].filter(d => !oldDocs.has(d.edrmsDocumentId)).map(brief),
        removed: [...oldDocs.values()].filter(d => !newDocs.has(d.edrmsDocumentId)).map(brief),
        updated: [...newDocs.values()].filter(d => oldDocs.has(d.edrmsDocumentId) && oldDocs.get(d.edrmsDocumentId).version !== d.version)
            .map(d => ({ ...brief(d), fromVersion: oldDocs.get(d.edrmsDocumentId).version }))
    };

    const empty = !fields.length && !Object.values(owners).some(l => l.length) && !Object.values(encumbrances).some(l => l.length) && !Object.values(documents).some(l => l.length);
    return { against: before ? 'current' : null, fields, owners, encumbrances, documents, empty };
}
