/** Styles both B/L screens use (CB-42): notes, and text for screen readers only. */
export const BL_SHARED_STYLES = `
.note {
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 13px;
}
.note.danger {
  background: var(--danger-bg);
  color: var(--danger-fg);
  border: 1px solid var(--danger-bd);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
`;
