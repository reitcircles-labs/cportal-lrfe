/**
 * What `npm run evidence` runs (evidence.mjs): the Playwright command and its environment, from
 * the script's arguments. Land by default; shipping (the shipping config and stack) with
 * `--shipping`, or for a spec in tests-shipping/ (CB-42).
 */

/** The ticket keys the script takes, e.g. API-606 or CB-42. */
const TICKET = /^[A-Z][A-Z0-9]+-\d+$/;

/** The folder of the shipping product's specs. */
const SHIPPING_SPECS = 'tests-shipping/';

/**
 * The plan of an evidence run.
 * @param {!Array<string>} argv the arguments: ticket keys, `--spec <file>`, `--shipping`
 * @return {?{
 *   tickets: !Array<string>,
 *   spec: ?string,
 *   shipping: boolean,
 *   args: !Array<string>,
 *   env: !Object<string, string>,
 * }} null for wrong arguments
 */
export function evidencePlan(argv) {
  const specAt = argv.indexOf('--spec');
  const spec = specAt < 0 ? null : (argv[specAt + 1] ?? null);
  if (specAt >= 0 && !spec) {
    return null;
  }
  const specIndexes = specAt < 0 ? [] : [specAt, specAt + 1];
  const tickets = argv.filter(
    (arg, i) => arg !== '--shipping' && !specIndexes.includes(i),
  );
  if (!tickets.length || tickets.some(t => !TICKET.test(t))) {
    return null;
  }
  const shipping =
    argv.includes('--shipping') || !!spec?.startsWith(SHIPPING_SPECS);
  const tags = tickets.map(t => `@${t}`).join('|');
  const args = ['playwright', 'test'];
  const env = {E2E_EVIDENCE: '1'};
  if (shipping) {
    // the shipping run has no sign-in setup: its specs sign their users in themselves
    args.push('-c', 'playwright.shipping.config.ts');
    if (spec) {
      args.push(spec);
    }
    args.push('--grep', tags);
    env.E2E_DOMAIN = 'shipping';
  } else if (spec) {
    // also the sign-in setup: its title starts "enrol the demo users"
    args.push('tests/auth.setup.ts', spec, '--no-deps', '--workers=1');
    args.push('--grep', `${tags}|enrol`);
  } else {
    args.push('--grep', tags);
  }
  return {tickets, spec, shipping, args, env};
}
