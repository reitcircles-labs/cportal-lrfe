/** CSS used by several components of an audit record: titles, tabs, notes, key-value lists and tones. */
export const AUDIT_SHARED_STYLES = `
.panel-title {
  margin: 0;
  padding: 14px 16px;
  font-size: 17px;
}
.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--color-divider);
  flex-wrap: wrap;
}
.tabs button {
  min-height: 40px;
  padding: 0 10px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  cursor: pointer;
  font: inherit;
  color: var(--color-neutral-700);
}
.tabs button.on {
  border-bottom-color: var(--color-accent);
  color: var(--color-accent-800);
  font-weight: 600;
}
.actions {
  gap: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--color-divider);
}
.reason {
  font-size: 13px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--color-neutral-100, #f7f9fb);
  border: 1px solid var(--color-divider);
}
.note {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 13px;
}
.note.danger {
  background: var(--danger-bg);
  color: var(--danger-fg);
  border: 1px solid var(--danger-bd);
}
.note.warn {
  background: var(--warn-bg);
  color: var(--warn-fg);
  border: 1px solid var(--warn-bd);
}
.note.info {
  background: var(--color-accent-100);
  border: 1px solid var(--color-divider);
}
.kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0;
  align-items: center;
}
.kv dd {
  margin: 0;
}
.tone-success {
  color: var(--success-fg);
}
.tone-danger {
  color: var(--danger-fg);
}
.tone-neutral {
  color: var(--color-neutral-700);
}
.tone-warn {
  color: var(--warn-fg);
}
.tone-accent {
  color: var(--color-accent-800);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
`;
