/** CSS used by several parts of the land record page: search, chips, results, threads, notes, forms. */
export const LINK_SHARED_STYLES = `
.search { position: relative; }
.search app-icon { position: absolute; left: 11px; top: 12px; color: var(--color-neutral-500); }
.search .input { padding-left: 34px; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 99px; border: 1px solid var(--color-neutral-300); background: var(--color-surface); cursor: pointer; font-size: 12px; font-weight: 600; color: var(--color-neutral-800); }
.chip b { color: var(--color-neutral-600); }
.chip.on { background: var(--color-accent-100); border-color: var(--color-accent-300); color: var(--color-accent-700); }
.ell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.note { padding: 10px 14px; border-radius: 10px; font-size: 13.5px; }
.note.warn { background: var(--warn-bg); color: var(--warn-fg); border: 1px solid var(--warn-bd); }
.danger:hover { background: var(--danger-bg) !important; color: var(--danger) !important; }
.empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 36px 20px; text-align: center; color: var(--color-neutral-600); }
.empty b { color: var(--color-text); }
.results { display: flex; flex-direction: column; gap: 8px; }
.res { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 10px 12px; border: 1px solid var(--color-divider); border-radius: 10px; background: var(--color-surface); }
.res.match { border-color: var(--color-accent-300); background: var(--color-accent-100); }
.res.pick { grid-template-columns: auto minmax(0, 1fr); cursor: pointer; }
.kv { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 6px 14px; font-size: 14px; }
.kv span:nth-child(odd) { color: var(--color-neutral-600); }
.thread { list-style: none; margin: 0; padding: 6px 18px; }
.thread li { display: flex; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--color-divider); }
.vh { display: flex; align-items: center; gap: 10px; padding: 14px 18px 0; font-size: 13.5px; color: var(--color-neutral-700); }
.vh i { flex: 1; height: 1px; background: var(--color-divider); }
.dev .what { font-size: 13.5px; font-weight: 600; color: var(--color-neutral-700); }
.dev.returned .what { color: var(--danger); }
.dev.approved .what { color: var(--success); }
.note.info { background: var(--color-accent-100); color: var(--color-accent-700); border: 1px solid var(--color-accent-300); }
.err { padding: 10px 12px; border-radius: 8px; background: var(--danger-bg); color: var(--danger-fg); border: 1px solid var(--danger-bd); font-size: 13.5px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.av { width: 34px; height: 34px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; background: var(--color-accent-500); color: #fff; }
.av.sm { width: 30px; height: 30px; font-size: 11px; }
.chk { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 10px; align-items: flex-start; }
.check-mark.bad { background: var(--danger-bg); color: var(--danger); border-color: var(--danger-bd); }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; margin-top: 4px; }
@media (max-width: 900px) {
  .res { grid-template-columns: 1fr; }
  .form-grid { grid-template-columns: 1fr; }
  .kv { grid-template-columns: 1fr; }
}
`;
