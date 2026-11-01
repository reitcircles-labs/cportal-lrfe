/**
 * Unit tests of the findings and the verdict (API-814): node --test security/*.test.mjs
 * The reports are small samples in each scanner's format, one of them with a seeded high finding.
 */
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
  applyAccepted,
  readNuclei,
  readOsv,
  readSchemathesis,
  readZap,
  summary,
  verdict,
} from './findings.mjs';

const dir = mkdtempSync(join(tmpdir(), 'lrfe-findings-'));
const write = (name, text) => {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
};

const zapFile = write(
  'zap.json',
  JSON.stringify({
    site: [
      {
        '@name': 'http://web:8080',
        alerts: [
          {
            pluginid: '40018',
            name: 'SQL Injection',
            riskcode: '3',
            confidence: '2',
            instances: [
              {uri: 'http://web:8080/api/records?q=1', method: 'GET'},
            ],
          },
          {
            pluginid: '10038',
            name: 'Content Security Policy (CSP) Header Not Set',
            riskcode: '2',
            confidence: '3',
            instances: [{uri: 'http://web:8080/', method: 'GET'}],
          },
          {
            pluginid: '10096',
            name: 'Timestamp Disclosure',
            riskcode: '0',
            confidence: '0',
            instances: [],
          },
        ],
      },
    ],
  }),
);

test('ZAP: risk codes become severities; its own false positives are left out', () => {
  const findings = readZap(zapFile, 'zap api (rec)');
  assert.deepEqual(
    findings.map(f => [f.id, f.severity]),
    [
      ['zap-40018', 'high'],
      ['zap-10038', 'medium'],
    ],
  );
  assert.equal(findings[0].where, 'GET http://web:8080/api/records?q=1');
});

test('Nuclei: critical counts as high, one finding per line', () => {
  const file = write(
    'nuclei.jsonl',
    [
      {
        'template-id': 'git-config',
        info: {name: 'Git Config', severity: 'critical'},
        'matched-at': 'http://web:8080/.git/config',
      },
      {
        'template-id': 'tech-detect',
        info: {name: 'Nginx', severity: 'info'},
        'matched-at': 'http://web:8080',
      },
    ]
      .map(line => JSON.stringify(line))
      .join('\n'),
  );
  assert.deepEqual(
    readNuclei(file).map(f => [f.id, f.severity]),
    [
      ['nuclei-git-config', 'high'],
      ['nuclei-tech-detect', 'info'],
    ],
  );
});

test('Schemathesis: a server error is high, a passing operation is no finding', () => {
  const file = write(
    'junit.xml',
    `<?xml version="1.0"?><testsuites><testsuite name="schemathesis">
<testcase name="POST /api/audit/anchoring" time="5.1" />
<testcase name="POST /api/records" time="0.1"><failure type="failure" message="1. Server error">Server error</failure></testcase>
<testcase name="GET /api/records/{id}" time="0.1"><failure type="failure" message="API accepts requests without authentication">API accepts requests without authentication (ignored_auth)</failure></testcase>
<testcase name="GET /api/roles" time="0.1"></testcase>
</testsuite></testsuites>`,
  );
  const findings = readSchemathesis(file, 'schemathesis (anonymous)');
  assert.deepEqual(
    findings.map(f => [f.where, f.severity]),
    [
      ['POST /api/records', 'high'],
      ['GET /api/records/{id}', 'high'],
    ],
  );
});

test('OSV-Scanner: rated by the highest CVSS score', () => {
  const file = write(
    'osv.json',
    JSON.stringify({
      results: [
        {
          source: {path: '/src/backend/package-lock.json'},
          packages: [
            {
              package: {name: 'fastify', version: '1.0.0'},
              groups: [
                {ids: ['GHSA-aaaa'], max_severity: '7.5'},
                {ids: ['GHSA-bbbb'], max_severity: '5.3'},
                {ids: ['GHSA-cccc'], max_severity: ''},
              ],
            },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(
    readOsv(file).map(f => [f.id, f.severity, f.where]),
    [
      ['osv-GHSA-aaaa', 'high', 'backend/package-lock.json'],
      ['osv-GHSA-bbbb', 'medium', 'backend/package-lock.json'],
      ['osv-GHSA-cccc', 'medium', 'backend/package-lock.json'],
    ],
  );
});

test('a missing report gives no findings (the scan reports it as not completed)', () => {
  assert.deepEqual(readZap(join(dir, 'none.json'), 'zap'), []);
  assert.deepEqual(readNuclei(join(dir, 'none.jsonl')), []);
});

test('the seeded high finding fails a blocking run and only reports otherwise', () => {
  const findings = readZap(zapFile, 'zap api (rec)');
  assert.equal(verdict(findings, true).ok, false);
  assert.equal(verdict(findings, true).high, 1);
  assert.equal(verdict(findings, false).ok, true);
});

test('an accepted finding no longer fails the run; a rule without a reason is refused', () => {
  const findings = applyAccepted(readZap(zapFile, 'zap api (rec)'), [
    {
      id: 'zap-40018',
      where: '/api/records',
      reason: 'test only',
      accepted: '2026-11-01',
    },
  ]);
  assert.equal(findings[0].accepted, 'test only');
  assert.deepEqual(verdict(findings, true), {
    ok: true,
    high: 0,
    counts: {high: 0, medium: 1, low: 0, info: 0, accepted: 1},
  });
  assert.throws(() => applyAccepted(findings, [{id: 'zap-40018'}]), /reason/);
  // `where` narrows a rule to the addresses it matches
  const other = applyAccepted(readZap(zapFile, 'zap'), [
    {id: 'zap-40018', where: '/api/users', reason: 'elsewhere'},
  ]);
  assert.equal(other[0].accepted, undefined);
});

test('the summary leads with the verdict and lists the high findings', () => {
  const findings = readZap(zapFile, 'zap api (rec)');
  const run = {level: 'pr', blocking: false, roles: ['rec'], errors: []};
  const text = summary(findings, run);
  assert.match(text, /\*\*Report only\*\* \(not blocking\): 1 open high/);
  assert.match(text, /\| zap api \(rec\) \| 1 \| 1 \| 0 \| 0 \| 0 \|/);
  assert.match(text, /### High\n\n- \*\*SQL Injection\*\*/);
  assert.match(
    summary(findings, {...run, blocking: true}),
    /\*\*Failed:\*\* 1 open high/,
  );
});
