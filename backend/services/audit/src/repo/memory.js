/**
 * In-memory audit repository: tests and `AUDIT_STORE=memory` (lost on restart). Same interface as
 * ./sequelize.js.
 */
export function createMemoryRepo() {
    const entries = [];
    let queue = Promise.resolve();

    const copy = (e) => structuredClone(e);
    const matches = (e, { subjects, type, from, to, exceptRecord }) =>
        (!subjects || e.subjects.some(s => subjects.includes(s)))
        && (!type || e.type === type || (type.endsWith('.') && e.type.startsWith(type)))
        && (!from || e.time >= from)
        && (!to || e.time < to)
        && (!exceptRecord || !e.subjects.some(s => s.startsWith('record:') && s !== exceptRecord));

    return {
        entries,                                       // tests change and remove entries directly
        async sync() {},

        /**
         * Append one entry, one writer at a time: `build(last)` makes it from the last entry. Null
         * (nothing written) when an entry for `eventId` exists already.
         */
        append(eventId, build) {
            const run = queue.then(() => {
                if (entries.some(e => e.eventId === eventId)) return null;
                const entry = build(entries.at(-1) ?? null);
                entries.push(copy(entry));
                return copy(entry);
            });
            queue = run.catch(() => {});
            return run;
        },

        async list(filter, { limit, offset }) {
            const found = entries.filter(e => matches(e, filter));
            return { total: found.length, entries: found.slice(offset, offset + limit).map(copy) };
        },

        /** Every subject of the entries that name one of `subjects` (apart from other records). */
        async linkedSubjects(subjects, { exceptRecord } = {}) {
            const out = new Set();
            for (const e of entries) if (matches(e, { subjects, exceptRecord })) e.subjects.forEach(s => out.add(s));
            return [...out];
        },

        /** Entries in order, from seq `after` + 1, at most `limit`. */
        async page(after, limit) {
            return entries.filter(e => e.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit).map(copy);
        }
    };
}
