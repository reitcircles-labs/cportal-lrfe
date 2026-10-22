// What a Claude Code session cost, from its transcript (API-790): model calls, tokens, the context
// each call carried, and what filled it. Reads the local transcripts only; nothing is sent anywhere.
//
//   node scripts/ai-cost.mjs                           the newest session of this checkout
//   node scripts/ai-cost.mjs --session <id or file>    a given session
//   node scripts/ai-cost.mjs --ticket API-794          only the span in which the ticket was worked on
//   node scripts/ai-cost.mjs --since 2026-10-22T22:30 --until 2026-10-22T23:00   (UTC, as stored)
//   node scripts/ai-cost.mjs --json                    the same as JSON
//
// The newest session is looked for in the transcript folders of this directory and of the folders
// whose names start like it (subfolders, and sibling clones such as ~/projects/cportal-lrfe-api768);
// pass --session to pick one. Token counts are the measure: prices change, tokens don't.
// A session's subagents (its subagents/ folder) are counted separately: each runs with its own,
// usually small, context. "Context per call" is what the model read on each call (input, cache
// reads and writes): the main cost driver when a long conversation is carried along.
import {createReadStream, existsSync, readdirSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, join} from 'node:path';
import {createInterface} from 'node:readline';

/** The value after an option, or the fallback. */
function option(name, fallback) {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
}

const PROJECTS = join(homedir(), '.claude', 'projects');

/** The transcript folder Claude Code keeps for a working directory. */
const folderOf = dir => join(PROJECTS, dir.replace(/[^A-Za-z0-9]/g, '-'));

/** The session's transcript file: given, by id, or the newest of this checkout's folders. */
function transcriptFile() {
  const given = option('--session');
  if (given && existsSync(given)) {
    return given;
  }
  const folders = readdirSync(PROJECTS)
    .map(name => join(PROJECTS, name))
    .filter(f => basename(f).startsWith(basename(folderOf(process.cwd()))));
  const files = folders.flatMap(folder =>
    readdirSync(folder)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => join(folder, f)),
  );
  if (given) {
    const match = files.find(f => basename(f, '.jsonl') === given);
    if (!match) {
      throw new Error(`no transcript for session ${given}`);
    }
    return match;
  }
  if (!files.length) {
    throw new Error(`no transcripts under ${folderOf(process.cwd())}*`);
  }
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/** Each event of a transcript, parsed, read line by line (a transcript can exceed 500 MB). */
async function* events(file) {
  const lines = createInterface({
    input: createReadStream(file, {encoding: 'utf8'}),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line) {
      continue;
    }
    try {
      yield JSON.parse(line);
    } catch {
      // a line cut off while the session was writing
    }
  }
}

/** The span of time in which `key` was mentioned: its first and last mention. */
async function ticketSpan(file, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escaped}\\b`);
  let first = null;
  let last = null;
  for await (const e of events(file)) {
    if (!e.timestamp || !pattern.test(JSON.stringify(e.message ?? ''))) {
      continue;
    }
    first ??= e.timestamp;
    last = e.timestamp;
  }
  if (!first) {
    throw new Error(`${key} is not mentioned in ${file}`);
  }
  return {since: first, until: last};
}

/** Which tool a tool call is, with the e2e runs and Jira uploads told apart. */
function toolName(block) {
  const command = block.input?.command ?? '';
  if (
    block.name === 'Bash' &&
    /playwright|test:docker|test:postgres/.test(command)
  ) {
    return 'Bash: e2e run';
  }
  if (block.name === 'Bash' && /api\.media\.atlassian\.com/.test(command)) {
    return 'Bash: Jira upload';
  }
  if (
    block.name === 'Read' &&
    /\.(png|jpe?g|gif|webp)$/i.test(block.input?.file_path ?? '')
  ) {
    return 'Read: image';
  }
  return block.name;
}

/** The cost of one transcript within [since, until]. */
async function measure(file, since, until) {
  const calls = new Map(); // request id → usage (one call can span several events)
  const tools = new Map(); // tool use id → name
  const results = new Map(); // tool name → {count, chars}
  for await (const e of events(file)) {
    if ((since && e.timestamp < since) || (until && e.timestamp > until)) {
      continue;
    }
    const message = e.message ?? {};
    if (e.type === 'assistant' && message.usage) {
      calls.set(e.requestId ?? message.id ?? e.uuid, message.usage);
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_use') {
        tools.set(block.id, toolName(block));
      } else if (block.type === 'tool_result') {
        const name = tools.get(block.tool_use_id) ?? 'unknown';
        const entry = results.get(name) ?? {count: 0, chars: 0};
        entry.count += 1;
        entry.chars += JSON.stringify(block.content ?? '').length;
        results.set(name, entry);
      }
    }
  }
  const sum = key => [...calls.values()].reduce((n, u) => n + (u[key] ?? 0), 0);
  const tokens = {
    input: sum('input_tokens'),
    cacheRead: sum('cache_read_input_tokens'),
    cacheWrite: sum('cache_creation_input_tokens'),
    output: sum('output_tokens'),
  };
  const context = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const totalChars = [...results.values()].reduce((n, r) => n + r.chars, 0);
  return {
    calls: calls.size,
    tokens,
    contextPerCall: calls.size ? Math.round(context / calls.size) : 0,
    toolResults: [...results.entries()]
      .sort((a, b) => b[1].chars - a[1].chars)
      .slice(0, 10)
      .map(([tool, r]) => ({
        tool,
        calls: r.count,
        share: totalChars ? Math.round((100 * r.chars) / totalChars) : 0,
      })),
  };
}

/** The session's subagents that ran in the span, together. */
async function measureSubagents(file, since, until) {
  const folder = join(file.replace(/\.jsonl$/, ''), 'subagents');
  if (!existsSync(folder)) {
    return null;
  }
  const each = [];
  for (const f of readdirSync(folder).filter(n => n.endsWith('.jsonl'))) {
    const m = await measure(join(folder, f), since, until);
    if (m.calls) {
      each.push(m);
    }
  }
  const add = key => each.reduce((n, m) => n + m.tokens[key], 0);
  const calls = each.reduce((n, m) => n + m.calls, 0);
  const context = add('input') + add('cacheRead') + add('cacheWrite');
  return {
    agents: each.length,
    calls,
    tokens: {
      input: add('input'),
      cacheRead: add('cacheRead'),
      cacheWrite: add('cacheWrite'),
      output: add('output'),
    },
    contextPerCall: calls ? Math.round(context / calls) : 0,
  };
}

const millions = n => `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)} M`;
const thousands = n => `${Math.round(n / 1000).toLocaleString('en')} k`;

try {
  const file = transcriptFile();
  const ticket = option('--ticket');
  const span = ticket
    ? await ticketSpan(file, ticket)
    : {since: option('--since'), until: option('--until')};
  const main = await measure(file, span.since, span.until);
  const subagents = await measureSubagents(file, span.since, span.until);
  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify({file, ticket, ...span, main, subagents}, null, 2),
    );
  } else {
    console.log(
      `Session ${basename(file, '.jsonl')}${ticket ? `, ${ticket}` : ''}`,
    );
    if (span.since || span.until) {
      console.log(`Span: ${span.since ?? 'start'} → ${span.until ?? 'end'}`);
    }
    const line = (label, m) =>
      console.log(
        `${label}: ${m.calls.toLocaleString('en')} calls · context per call ${thousands(m.contextPerCall)} · ` +
          `cache read ${millions(m.tokens.cacheRead)} · cache write ${millions(m.tokens.cacheWrite)} · ` +
          `input ${millions(m.tokens.input)} · output ${millions(m.tokens.output)}`,
      );
    line('Main conversation', main);
    if (subagents) {
      line(`Subagents (${subagents.agents})`, subagents);
    }
    console.log(
      'What filled the main context (tool results, share of characters):',
    );
    for (const r of main.toolResults) {
      console.log(
        `  ${r.tool.padEnd(52)} ${String(r.share).padStart(3)}%  ${r.calls} calls`,
      );
    }
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
