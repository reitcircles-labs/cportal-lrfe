// The lint guard that keeps shared code from importing product code (CB-5, eslint.config.mjs,
// docs/architecture/products.md): it flags such imports and lets the allowed ones through.
// Run with `npm run test:lint-guard` at the repository root.
import assert from 'node:assert/strict';
import path from 'node:path';
import {describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

import {ESLint} from 'eslint';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const eslint = new ESLint({cwd: REPO_ROOT});

/**
 * Lints a piece of code as if it were the given file, and returns the guard's messages only.
 * @param {string} code
 * @param {string} filePath relative to the repository root; the file need not exist
 * @return {Promise<string[]>}
 */
async function guardMessages(code, filePath) {
  const [result] = await eslint.lintText(code, {
    filePath: path.join(REPO_ROOT, filePath),
    warnIgnored: true,
  });
  // An ignored file is not linted at all, so an empty answer would prove nothing.
  assert.ok(
    !result.messages.some(message => /File ignored/.test(message.message)),
    `${filePath} is ignored by the lint configuration`,
  );
  return result.messages
    .filter(message => message.ruleId === 'no-restricted-imports')
    .map(message => message.message);
}

describe('shared code may not import product code', () => {
  it('flags a domain pack imported by a shared package', async () => {
    const messages = await guardMessages(
      "import {pack} from '@lrfe/domain-land';\nexport {pack};\n",
      'backend/packages/common/src/guard-sample.js',
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0], /docs\/architecture\/products\.md/);
  });

  it('flags another product pack and land-records by package name', async () => {
    const messages = await guardMessages(
      "import {a} from '@lrfe/domain-shipping/src/x.js';\n" +
        "import {b} from '@lrfe/land-records';\nexport {a, b};\n",
      'backend/services/audit/src/guard-sample.js',
    );
    assert.equal(messages.length, 2);
  });

  it('flags shipping-records imported by package name and by relative path', async () => {
    const messages = await guardMessages(
      "import {a} from '@lrfe/shipping-records';\n" +
        "import {b} from '../../shipping-records/src/x.js';\nexport {a, b};\n",
      'backend/services/audit/src/guard-sample.js',
    );
    assert.equal(messages.length, 2);
  });

  it('flags land-records imported by relative path from a shared service', async () => {
    const messages = await guardMessages(
      "import {x} from '../../land-records/src/x.js';\nexport {x};\n",
      'backend/services/audit/src/guard-sample.js',
    );
    assert.equal(messages.length, 1);
  });

  it('flags a domain pack imported by relative path from a shared script', async () => {
    const messages = await guardMessages(
      "import {x} from '../../../domains/land/src/index.js';\nexport {x};\n",
      'backend/services/audit/scripts/guard-sample.js',
    );
    assert.equal(messages.length, 1);
  });

  it('flags a product app imported by the platform library', async () => {
    const messages = await guardMessages(
      "import {X} from '../../../land-registry/src/app/x';\n" +
        "import {Y} from '../../../shipping/src/app/y';\nexport {X, Y};\n",
      'angular-app/projects/platform/src/lib/guard-sample.ts',
    );
    assert.equal(messages.length, 2);
  });
});

describe('allowed imports pass the guard', () => {
  it('lets shared code import @lrfe/domain-pack', async () => {
    const messages = await guardMessages(
      "import {definePack} from '@lrfe/domain-pack';\nexport {definePack};\n",
      'backend/packages/common/src/guard-sample.js',
    );
    assert.deepEqual(messages, []);
  });

  it('lets @lrfe/common load the configured pack by name', async () => {
    const messages = await guardMessages(
      'export async function load(name) {\n' +
        '  return import(`@lrfe/domain-${name}`);\n}\n',
      'backend/packages/common/src/guard-sample.js',
    );
    assert.deepEqual(messages, []);
  });

  it('lets products import shared code', async () => {
    const backend = "import {x} from '@lrfe/common';\nexport {x};\n";
    const web = "import {Y} from '@lrfe/platform';\nexport {Y};\n";
    assert.deepEqual(
      await guardMessages(backend, 'backend/domains/land/src/guard-sample.js'),
      [],
    );
    assert.deepEqual(
      await guardMessages(
        backend,
        'backend/services/land-records/src/guard-sample.js',
      ),
      [],
    );
    assert.deepEqual(
      await guardMessages(
        "import {x} from '@lrfe/domain-shipping/bill-of-lading';\nexport {x};\n",
        'backend/services/shipping-records/src/guard-sample.js',
      ),
      [],
    );
    assert.deepEqual(
      await guardMessages(
        web,
        'angular-app/projects/shipping/src/app/guard-sample.ts',
      ),
      [],
    );
  });

  it('lets a shared service test use land-records helpers', async () => {
    const messages = await guardMessages(
      "import {x} from '../../land-records/tests/helpers.js';\nexport {x};\n",
      'backend/services/extracts/tests/guard-sample.test.js',
    );
    assert.deepEqual(messages, []);
  });
});
