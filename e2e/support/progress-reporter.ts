/**
 * A run that can be followed live (API-813): one short line per finished test, errors outside
 * tests (the stack not starting) and the totals, in `e2e/.progress/progress.log`, started afresh
 * by each run. Follow it with `tail -f e2e/.progress/progress.log`.
 */
import {appendFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
} from '@playwright/test/reporter';

/** The e2e folder. */
const E2E_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the progress is written: `E2E_PROGRESS_FILE`, else `e2e/.progress/progress.log`. */
const FILE =
  process.env.E2E_PROGRESS_FILE || join(E2E_DIR, '.progress', 'progress.log');

/** Terminal colour codes in error messages. */
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** The clock time as HH:MM:SS. */
function clock(): string {
  return new Date().toTimeString().slice(0, 8);
}

/** The first line of an error, without colour codes. */
function firstLine(error: TestError | undefined): string {
  const text = (error?.message ?? error?.value ?? '').replace(COLOUR, '');
  return text.split('\n').find(line => line.trim()) ?? '';
}

/** Which stack the run uses, as the scripts in package.json choose it. */
function stackName(): string {
  if (process.env.E2E_DOCKER) {
    return `docker, EDRMS_SEARCH=${process.env.EDRMS_SEARCH || 'postgres'}`;
  }
  return process.env.E2E_DB === 'postgres' ? 'PostgreSQL' : 'memory';
}

/** Writes the progress file. */
// Playwright loads a reporter from its file's default export
// eslint-disable-next-line no-restricted-syntax
export default class ProgressReporter implements Reporter {
  private total = 0;
  private done = 0;
  private readonly counts = new Map<string, number>();

  constructor() {
    mkdirSync(dirname(FILE), {recursive: true});
    writeFileSync(
      FILE,
      `${clock()} run started (${stackName()}); starting the stack…\n`,
    );
  }

  /** The stack is up and the tests are listed. */
  onBegin(config: FullConfig, suite: Suite): void {
    this.total = suite.allTests().length;
    this.write(`${this.total} tests, ${config.workers} workers`);
  }

  /** One line per finished test; a retried test counts once, at its last try. */
  onTestEnd(test: TestCase, result: TestResult): void {
    if (
      result.status !== 'skipped' &&
      result.retry < test.retries &&
      test.outcome() !== 'expected'
    ) {
      return;
    }
    this.done += 1;
    this.counts.set(result.status, (this.counts.get(result.status) ?? 0) + 1);
    const mark = {
      passed: 'ok    ',
      failed: 'FAILED',
      timedOut: 'FAILED',
      skipped: 'skip  ',
      interrupted: 'stop  ',
    }[result.status];
    const file = relative(E2E_DIR, test.location.file);
    const seconds = (result.duration / 1000).toFixed(1);
    this.write(
      `[${this.done}/${this.total}] ${mark} ${file}:${test.location.line} ${test.title} (${seconds} s)`,
    );
    if (result.status === 'failed' || result.status === 'timedOut') {
      this.write(`        ${firstLine(result.error)}`);
    }
  }

  /** An error outside a test: the stack not starting, a setup failing. */
  onError(error: TestError): void {
    this.write(`ERROR ${firstLine(error)}`);
  }

  /** The totals. */
  onEnd(result: FullResult): void {
    const parts = ['passed', 'failed', 'timedOut', 'skipped', 'interrupted']
      .filter(status => this.counts.has(status))
      .map(status => `${this.counts.get(status)} ${status}`);
    const notRun = this.total - this.done;
    if (notRun > 0) parts.push(`${notRun} did not run`);
    const minutes = (result.duration / 60_000).toFixed(1);
    this.write(
      `run ${result.status}: ${parts.join(', ') || 'no tests'} (${minutes} min)`,
    );
  }

  /** Progress goes to the file only, never to the console. */
  printsToStdio(): boolean {
    return false;
  }

  private write(line: string): void {
    appendFileSync(FILE, `${clock()} ${line}\n`);
  }
}
