import {readdir, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {domain} from '@lrfe/common';

const DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * The process definitions bpm deploys at boot (CB-3), sorted by key: the platform's, which ship as
 * JSON files in this folder, and the product's, from the domain pack's `workflows` section.
 *
 * A platform file with `acknowledgeTask` (audit-finding, audit-rereview: started by the audit
 * service) is made whole with the pack's `auditAcknowledgers`: one acknowledgement task per role,
 * in parallel when there are several. A pack that names none has no such process: nobody would see
 * its tasks. The pack's `descriptions` replace the platform's own wording.
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @param {string=} dir the folder of the platform's JSON files
 * @return {!Promise<!Array<!Object>>}
 */
export async function loadDefinitions(pack = domain, dir = DIR) {
  const workflows = pack.workflows;
  const files = (await readdir(dir)).filter(f => f.endsWith('.json')).sort();
  const platform = await Promise.all(
    files.map(async f => JSON.parse(await readFile(`${dir}/${f}`, 'utf8'))),
  );
  const definitions = [];
  for (const template of platform) {
    const definition =
      'acknowledgeTask' in template
        ? withAcknowledgers(template, workflows.auditAcknowledgers ?? [])
        : template;
    if (definition) {
      const description = workflows.descriptions?.[definition.key];
      if (description !== undefined) {
        definition.description = description;
      }
      definitions.push(definition);
    }
  }
  const platformKeys = new Set(platform.map(d => d.key));
  for (const definition of workflows.definitions ?? []) {
    if (platformKeys.has(definition.key)) {
      throw new Error(
        `Domain pack ${pack.name}: the workflow "${definition.key}" has the key of a platform workflow`,
      );
    }
    // a copy: the pack is frozen, and the engine keeps what it is given
    definitions.push(structuredClone(definition));
  }
  return definitions.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * A platform definition with its acknowledgement tasks: from start, one task per acknowledger (a
 * parallel gateway "notify" and a join "acknowledged" around them when there are several), then
 * the template's end "done". Each task is named by the acknowledger's `task`, assigned to its
 * `role`, and keeps its answer in `<task>Ack`. Null without acknowledgers.
 * @param {!Object} template the JSON file, with `acknowledgeTask` {title, outcomes, dueInHours}
 * @param {!Array<{task: string, role: string}>} acknowledgers
 * @return {?Object}
 */
function withAcknowledgers(template, acknowledgers) {
  if (acknowledgers.length === 0) {
    return null;
  }
  const {acknowledgeTask, nodes: templateNodes, ...definition} = template;
  const tasks = acknowledgers.map(({task}) => task);
  const parallel = tasks.length > 1;
  const nodes = {
    start: {type: 'start', next: parallel ? 'notify' : tasks[0]},
  };
  if (parallel) {
    nodes.notify = {type: 'parallelGateway', next: tasks};
  }
  for (const {task, role} of acknowledgers) {
    nodes[task] = {
      type: 'humanTask',
      title: structuredClone(acknowledgeTask.title),
      assignee: {role},
      outcomes: [...acknowledgeTask.outcomes],
      outputVar: `${task}Ack`,
      dueInHours: acknowledgeTask.dueInHours,
      next: parallel ? 'acknowledged' : 'done',
    };
  }
  if (parallel) {
    nodes.acknowledged = {type: 'join', next: 'done'};
  }
  return {...definition, nodes: {...nodes, ...templateNodes}};
}

/**
 * Deploys every definition of this install (loadDefinitions); unchanged ones are skipped.
 * @param {!Object} engine the BpmEngine
 * @param {{log: function(string)=}=} options
 */
export async function deployAll(engine, {log = () => {}} = {}) {
  for (const def of await loadDefinitions()) {
    const {definition, deployed} = await engine.deployDefinition(def);
    if (deployed) {
      log(`deployed ${definition.key} v${definition.version}`);
    }
  }
}
