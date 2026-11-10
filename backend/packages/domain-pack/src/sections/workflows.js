import {fail, isObject} from '../fail.js';

/** The fields a `workflows` section may have; each is optional. */
const FIELDS = Object.freeze([
  'definitions',
  'auditAcknowledgers',
  'descriptions',
]);

/** A process key, as bpm's URLs and the audit trail hold it: `land-record-review`. */
const KEY = /^[a-z][a-z0-9-]{0,62}$/;

/** A task's node name, which also names its answer (`<task>Ack`): `officer`. */
const TASK = /^[a-z][A-Za-z0-9]{0,30}$/;

/** The node names bpm gives the audit workflows itself, which no task may take. */
const RESERVED_TASKS = Object.freeze([
  'start',
  'notify',
  'acknowledged',
  'done',
]);

/**
 * Checks the `workflows` section of a domain pack: what bpm deploys for the product. Every field
 * is optional, so an empty section (`{}`) is a product without workflows of its own.
 *
 * - `definitions`: the product's own process definitions, deployed as they are. Each has a `key`,
 *   a `name` and its `nodes`; bpm checks the rest of it (engine/validator.js) when it deploys it.
 * - `auditAcknowledgers`: who acknowledges what the audit service raises (bpm's audit-finding and
 *   audit-rereview), one task each: `{task, role}`, `task` the node's name, `role` a role id.
 *   None: those processes are not deployed.
 * - `descriptions`: the platform's definitions described in the product's words, by key.
 * @param {string} pack the pack's name, for the error
 * @param {object} section the section
 */
export function checkWorkflows(pack, section) {
  if (!isObject(section)) {
    fail(pack, '"workflows" is not an object');
  }
  for (const field of Object.keys(section)) {
    if (!FIELDS.includes(field)) {
      fail(pack, `workflows: unknown field "${field}"`);
    }
  }
  checkDefinitions(pack, section.definitions ?? []);
  checkAcknowledgers(pack, section.auditAcknowledgers ?? []);
  checkDescriptions(pack, section.descriptions ?? {});
}

/**
 * Checks the product's definitions: a list, each with its own key, a name and nodes.
 * @param {string} pack the pack's name, for the error
 * @param {unknown} definitions
 */
function checkDefinitions(pack, definitions) {
  if (!Array.isArray(definitions)) {
    fail(pack, 'workflows: "definitions" is not a list');
  }
  const keys = new Set();
  definitions.forEach((definition, index) => {
    if (!isObject(definition)) {
      fail(pack, `workflows: definition ${index} is not an object`);
    }
    const key = definition.key;
    if (typeof key !== 'string' || !KEY.test(key)) {
      fail(pack, `workflows: definition ${index} has no valid key ("${key}")`);
    }
    if (keys.has(key)) {
      fail(pack, `workflows: two definitions have the key "${key}"`);
    }
    keys.add(key);
    if (typeof definition.name !== 'string' || definition.name === '') {
      fail(pack, `workflows: definition "${key}" has no name`);
    }
    if (!isObject(definition.nodes)) {
      fail(pack, `workflows: definition "${key}" has no nodes`);
    }
  });
}

/**
 * Checks the audit acknowledgers: a list of `{task, role}`, each task named once.
 * @param {string} pack the pack's name, for the error
 * @param {unknown} acknowledgers
 */
function checkAcknowledgers(pack, acknowledgers) {
  if (!Array.isArray(acknowledgers)) {
    fail(pack, 'workflows: "auditAcknowledgers" is not a list');
  }
  const tasks = new Set();
  acknowledgers.forEach((acknowledger, index) => {
    if (!isObject(acknowledger)) {
      fail(pack, `workflows: audit acknowledger ${index} is not an object`);
    }
    const {task, role} = acknowledger;
    if (
      typeof task !== 'string' ||
      !TASK.test(task) ||
      RESERVED_TASKS.includes(task)
    ) {
      fail(
        pack,
        `workflows: audit acknowledger ${index} has no valid task name ("${task}")`,
      );
    }
    if (tasks.has(task)) {
      fail(pack, `workflows: two audit acknowledgers have the task "${task}"`);
    }
    tasks.add(task);
    if (typeof role !== 'string' || role === '') {
      fail(pack, `workflows: audit acknowledger "${task}" has no role`);
    }
  });
}

/**
 * Checks the descriptions: texts by process key.
 * @param {string} pack the pack's name, for the error
 * @param {unknown} descriptions
 */
function checkDescriptions(pack, descriptions) {
  if (!isObject(descriptions)) {
    fail(pack, 'workflows: "descriptions" is not an object');
  }
  for (const [key, text] of Object.entries(descriptions)) {
    if (typeof text !== 'string' || text === '') {
      fail(pack, `workflows: the description of "${key}" is not a text`);
    }
  }
}
