/**
 * The endorsee of a B/L (CB-37, docs/chain-of-title.md): the organisation it is endorsed to by
 * name, read from its chain of title. The endorsee is never written into the stored document
 * (Jira CB-37 comment 11579); a format that writes a B/L out (the DCSA converter) adds it.
 */

/**
 * The organisation a B/L is endorsed to by name: the `to` of the latest `endorse` entry of its
 * chain of title when that endorsement is named; null when it is a blank endorsement or there is
 * none. The commands after it (transfer, surrender, release) do not change it.
 *
 * @param {!Array<{command: string, to: ?string, endorsement: string}>} entries the chain of
 *     title, in seq order
 * @return {?string} the organisation's id, or null
 */
export function endorseeOf(entries) {
  const latest = entries.findLast(entry => entry.command === 'endorse');
  if (latest === undefined || latest.endorsement !== 'named') {
    return null;
  }
  return latest.to ?? null;
}
