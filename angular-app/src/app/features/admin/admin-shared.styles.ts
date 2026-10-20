/** CSS used by several Administration tabs: toolbars, search, list footers, save bars and dialog forms. */
export const ADMIN_SHARED_STYLES = `
    .toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 14px 16px; border-bottom: 1px solid var(--color-divider); }
    .search { position: relative; width: min(300px, 100%); }
    .search app-icon { position: absolute; left: 11px; top: 12px; color: var(--color-neutral-500); }
    .search .input { padding-left: 34px; }
    .foot { padding: 10px 16px; border-top: 1px solid var(--color-divider); }
    tr.click { cursor: pointer; }
    .danger { color: var(--danger) !important; }
    .savebar { position: sticky; bottom: 16px; z-index: 5; display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-radius: var(--radius-lg); background: var(--sidebar-bg); color: #fff; box-shadow: var(--shadow-lg); flex-wrap: wrap; }
    .savebar .btn-secondary { background: transparent; color: #fff; border-color: rgba(255,255,255,.3); }
    .fg { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; }
    @media (max-width: 640px) { .fg { grid-template-columns: 1fr; } .toolbar .seg { overflow-x: auto; max-width: 100%; } }
`;
