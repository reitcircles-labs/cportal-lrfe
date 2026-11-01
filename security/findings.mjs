/**
 * The penetration tests' findings (API-814): reads the report of each scanner into one list, marks
 * the findings accepted in security/accepted-findings.json, and gives the verdict and the summary.
 * Used by security/scan.mjs; no I/O here except reading the report files it is given.
 *
 * A finding: {tool, id, title, severity, where, accepted?}, severity one of high, medium, low, info
 * ("critical" counts as high).
 */
import {existsSync, readFileSync} from 'node:fs';

export const SEVERITIES = ['high', 'medium', 'low', 'info'];

/** ZAP's riskcode: 3 High, 2 Medium, 1 Low, 0 Informational. */
const ZAP_RISK = {3: 'high', 2: 'medium', 1: 'low', 0: 'info'};

/**
 * Schemathesis' checks and what a failure of each one means for security: a server error or an
 * endpoint that answers without its sign-in is high; the rest are flaws in how the API behaves.
 */
const SCHEMATHESIS_SEVERITY = {
  not_a_server_error: 'high',
  ignored_auth: 'high',
  object_level_authorization: 'high',
  use_after_free: 'medium',
  ensure_resource_availability: 'medium',
};

/** The titles Schemathesis gives each check's failure in its reports, besides the check's name. */
const SCHEMATHESIS_TITLES = {
  not_a_server_error: ['Server error'],
  ignored_auth: ['API accepts requests without authentication'],
  object_level_authorization: ['Object-level authorization'],
  use_after_free: ['Use after free'],
  ensure_resource_availability: ['Resource is not available'],
};

/** Reads a file as text, or null when the scanner wrote none. */
function readIfThere(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/**
 * ZAP's JSON report (zap-baseline.py, zap-api-scan.py, -J): one finding per alert and site, with
 * up to three of its addresses. Alerts ZAP itself rates as false positives (confidence 0) are left out.
 *
 * @param {string} file the report
 * @param {string} tool the name the finding carries, e.g. "zap api (rec)"
 * @return {object[]} the findings
 */
export function readZap(file, tool) {
  const text = readIfThere(file);
  if (!text) {
    return [];
  }
  const findings = [];
  for (const site of JSON.parse(text).site ?? []) {
    for (const alert of site.alerts ?? []) {
      if (String(alert.confidence) === '0') {
        continue;
      }
      const uris = (alert.instances ?? []).map(i =>
        `${i.method ?? ''} ${i.uri}`.trim(),
      );
      findings.push({
        tool,
        // alertRef tells apart the alerts of one rule (90004-1, -2, -3: three different headers)
        id: `zap-${alert.alertRef ?? alert.pluginid}`,
        title: alert.name ?? alert.alert,
        severity: ZAP_RISK[Number(alert.riskcode)] ?? 'info',
        where: uris.slice(0, 3).join(', ') + (uris.length > 3 ? ', …' : ''),
      });
    }
  }
  return findings;
}

/**
 * Nuclei's JSON lines (-jsonl): one finding per template and address.
 *
 * @param {string} file the report
 * @param {string} tool the name the finding carries
 * @return {object[]} the findings
 */
export function readNuclei(file, tool = 'nuclei') {
  const text = readIfThere(file);
  if (!text) {
    return [];
  }
  return text
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line))
    .map(hit => {
      const severity = String(hit.info?.severity ?? 'info').toLowerCase();
      return {
        tool,
        id: `nuclei-${hit['template-id']}`,
        title: hit.info?.name ?? hit['template-id'],
        severity:
          severity === 'critical'
            ? 'high'
            : SEVERITIES.includes(severity)
              ? severity
              : 'info',
        where: hit['matched-at'] ?? hit.host ?? '',
      };
    });
}

/**
 * Schemathesis' JUnit report: one finding per operation and failed check. The check's name is in
 * the failure's text; an operation that failed several checks gives one finding for each.
 *
 * @param {string} file the report
 * @param {string} tool the name the finding carries
 * @return {object[]} the findings
 */
export function readSchemathesis(file, tool) {
  const text = readIfThere(file);
  if (!text) {
    return [];
  }
  const findings = [];
  // a passing operation is a short element (<testcase … />), a failing one holds its failures
  const cases = text.matchAll(
    /<testcase\b[^>]*?\bname="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g,
  );
  for (const [, operation, body = ''] of cases) {
    if (!/<(failure|error)\b/.test(body)) {
      continue;
    }
    const checks = Object.keys(SCHEMATHESIS_SEVERITY).filter(
      check =>
        body.includes(check) ||
        SCHEMATHESIS_TITLES[check].some(title => body.includes(title)),
    );
    for (const check of checks.length ? checks : ['other']) {
      findings.push({
        tool,
        id: `schemathesis-${check}`,
        title:
          check === 'other' ? 'API test failed' : check.replaceAll('_', ' '),
        severity: SCHEMATHESIS_SEVERITY[check] ?? 'low',
        where: unescapeXml(operation),
      });
    }
  }
  return findings;
}

/** The five XML entities, back to their characters. */
function unescapeXml(text) {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/**
 * OSV-Scanner's JSON report (--format json): one finding per package and known vulnerability,
 * rated by its highest CVSS score (9+ and 7+ high, 4+ medium, else low; none given: medium).
 *
 * @param {string} file the report
 * @return {object[]} the findings
 */
export function readOsv(file) {
  const text = readIfThere(file);
  if (!text) {
    return [];
  }
  const findings = [];
  for (const result of JSON.parse(text).results ?? []) {
    const lockfile = result.source?.path ?? '';
    for (const pkg of result.packages ?? []) {
      for (const group of pkg.groups ?? []) {
        const score = Number.parseFloat(group.max_severity);
        const severity = Number.isNaN(score)
          ? 'medium'
          : score >= 7
            ? 'high'
            : score >= 4
              ? 'medium'
              : 'low';
        findings.push({
          tool: 'osv-scanner',
          id: `osv-${group.ids[0]}`,
          title: `${pkg.package.name} ${pkg.package.version}: ${group.ids.join(', ')}`,
          severity,
          where: lockfile.replace(/^\/src\//, ''),
        });
      }
    }
  }
  return findings;
}

/**
 * Marks the findings that a rule of security/accepted-findings.json accepts: same id, and `where`
 * (a regular expression), when the rule gives one, matching the finding's address. Every rule
 * must carry its reason.
 *
 * @param {object[]} findings the findings
 * @param {object[]} rules the accepted findings: {id, where?, reason, accepted}
 * @return {object[]} the same findings, each with `accepted` (the rule's reason) when one matches
 */
export function applyAccepted(findings, rules) {
  for (const rule of rules) {
    if (!rule.id || !rule.reason) {
      throw new Error(
        `accepted-findings.json: every rule needs an id and a reason (${JSON.stringify(rule)})`,
      );
    }
  }
  return findings.map(finding => {
    const rule = rules.find(
      r =>
        r.id === finding.id &&
        (!r.where || new RegExp(r.where).test(finding.where)),
    );
    return rule ? {...finding, accepted: rule.reason} : finding;
  });
}

/**
 * The run's verdict: it fails only when blocking is on and a high finding is not accepted.
 *
 * @param {object[]} findings the findings, after applyAccepted
 * @param {boolean} blocking whether high findings fail the run
 * @return {{ok: boolean, high: number, counts: object}} the verdict and the counts per severity
 */
export function verdict(findings, blocking) {
  const open = findings.filter(f => !f.accepted);
  const counts = Object.fromEntries(
    SEVERITIES.map(s => [s, open.filter(f => f.severity === s).length]),
  );
  counts.accepted = findings.length - open.length;
  return {ok: !blocking || counts.high === 0, high: counts.high, counts};
}

/**
 * The summary in Markdown, for the job summary and the reports folder: the counts per tool, then
 * the high and medium findings (the low and informational ones are in findings.json).
 *
 * @param {object[]} findings the findings, after applyAccepted
 * @param {{level: string, blocking: boolean, roles: string[], errors: string[]}} run the run's settings
 * @return {string} the summary
 */
export function summary(findings, run) {
  const {ok, counts} = verdict(findings, run.blocking);
  const tools = [...new Set(findings.map(f => f.tool))].sort();
  const lines = [
    `## Penetration tests (${run.level}, signed in as ${run.roles.join(', ')} and signed out)`,
    '',
    run.blocking
      ? ok
        ? '**Passed:** no open high finding.'
        : `**Failed:** ${counts.high} open high finding(s).`
      : `**Report only** (not blocking): ${counts.high} open high finding(s).`,
    '',
  ];
  for (const error of run.errors) {
    lines.push(`- **Scanner not completed:** ${error}`);
  }
  if (run.errors.length) {
    lines.push('');
  }
  lines.push(
    '| Tool | High | Medium | Low | Info | Accepted |',
    '|---|---|---|---|---|---|',
  );
  for (const tool of tools) {
    const own = findings.filter(f => f.tool === tool);
    const n = s => own.filter(f => !f.accepted && f.severity === s).length;
    lines.push(
      `| ${tool} | ${n('high')} | ${n('medium')} | ${n('low')} | ${n('info')} | ${own.filter(f => f.accepted).length} |`,
    );
  }
  if (!tools.length) {
    lines.push('| (no findings) | 0 | 0 | 0 | 0 | 0 |');
  }
  for (const severity of ['high', 'medium']) {
    const open = findings.filter(f => !f.accepted && f.severity === severity);
    if (!open.length) {
      continue;
    }
    lines.push('', `### ${severity === 'high' ? 'High' : 'Medium'}`, '');
    for (const f of open.slice(0, 40)) {
      lines.push(`- **${f.title}** (${f.tool}, ${f.id}): ${f.where || '-'}`);
    }
    if (open.length > 40) {
      lines.push(`- … and ${open.length - 40} more in findings.json`);
    }
  }
  return `${lines.join('\n')}\n`;
}
