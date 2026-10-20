// Lint findings per area: how many lint findings and unformatted files each area of the repository
// has, as a Markdown table, for the CI summary and to see where a failing check comes from
// (docs/coding-guide.md).
//
//   npm run lint:report                  prints the report
//   npm run lint:report -- report.md     also writes it to report.md
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {relative} from 'node:path';

import {ESLint} from 'eslint';

/** Areas of the repository, most specific first; a file belongs to the first that matches. */
const AREAS = [
  'backend/packages/common',
  'backend/packages/storage',
  'backend/services/gateway',
  'backend/services/land-records',
  'backend/services/bpm',
  'backend/services/audit',
  'backend/services/identity',
  'backend/services/edrms',
  'backend/services/intake',
  'backend/scripts',
  'angular-app/src/app/features',
  'angular-app/src',
  'angular-app',
  'e2e',
];
const OTHER = 'other';

/** The area a repository path belongs to. */
function areaOf(path) {
  return AREAS.find(area => path.startsWith(`${area}/`)) ?? OTHER;
}

/** Files Prettier would change (it exits with 1 when there are any). */
function unformattedFiles() {
  try {
    execFileSync('npx', ['prettier', '--list-different', '.'], {
      encoding: 'utf8',
    });
    return [];
  } catch (error) {
    if (error.status !== 1) {
      throw error;
    }
    return error.stdout.split('\n').filter(Boolean);
  }
}

/** Adds one to a counter in a Map. */
function increment(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** The counts of one area, created empty the first time the area is seen. */
function areaStats(areas, area) {
  if (!areas.has(area)) {
    areas.set(area, {files: 0, errors: 0, warnings: 0, unformatted: 0});
  }
  return areas.get(area);
}

/** Collects the lint findings and formatting state per area, and per rule. */
async function collect() {
  const results = await new ESLint().lintFiles(['.']);
  const areas = new Map();
  const rules = new Map();
  for (const result of results) {
    const path = relative(process.cwd(), result.filePath);
    const stats = areaStats(areas, areaOf(path));
    stats.files++;
    stats.errors += result.errorCount;
    stats.warnings += result.warningCount;
    for (const message of result.messages) {
      increment(rules, message.ruleId ?? 'parse error');
    }
  }
  for (const path of unformattedFiles()) {
    areaStats(areas, areaOf(path)).unformatted++;
  }
  return {areas, rules};
}

/** Today's date in local time, as YYYY-MM-DD. */
function today() {
  return new Date().toLocaleDateString('en-CA');
}

/** The report as Markdown. */
function toMarkdown({areas, rules}) {
  const lines = [
    '# Lint baseline',
    '',
    `${today()}, from \`npm run lint:report\`.`,
    '',
    '| Area | Files linted | Errors | Warnings | Files to format |',
    '|---|---:|---:|---:|---:|',
  ];
  const order = [...AREAS, OTHER];
  const sorted = [...areas.entries()].sort(
    ([a], [b]) => order.indexOf(a) - order.indexOf(b),
  );
  for (const [area, stats] of sorted) {
    lines.push(
      `| ${area} | ${stats.files} | ${stats.errors} | ${stats.warnings} | ${stats.unformatted} |`,
    );
  }
  lines.push('', '| Rule | Findings |', '|---|---:|');
  const mostFirst = [...rules.entries()].sort((a, b) => b[1] - a[1]);
  for (const [rule, count] of mostFirst) {
    lines.push(`| ${rule} | ${count} |`);
  }
  return `${lines.join('\n')}\n`;
}

const report = toMarkdown(await collect());
process.stdout.write(report);
const outFile = process.argv[2];
if (outFile) {
  writeFileSync(outFile, report);
}
