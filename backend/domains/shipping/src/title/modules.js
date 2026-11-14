import {TITLE_COMMANDS} from './table.js';

/**
 * The title modules (CB-38, docs/title-states.md): the parts of the title engine an install
 * switches on with `LRFE_BL_MODULES`. The module of each command is in `TITLE_COMMANDS`; a module
 * that is off only refuses its new commands: no stored title depends on the setting.
 */

/**
 * A title module.
 *
 * @typedef {object} TitleModule
 * @property {string} name the module's name in `LRFE_BL_MODULES`, e.g. `negotiable`
 * @property {string} label the module's name for people, e.g. `Negotiable B/Ls`
 * @property {!Array<string>} needs the modules it cannot be on without
 * @property {!Array<string>} commands the commands that belong to it, wholly or for some cases
 *     (issue and void by the kind of B/L, endorse in blank), in the table's order
 */

/** The module that is always on: sea waybills and straight B/Ls. */
export const ALWAYS_ON = 'waybill';

/**
 * The commands of a module, from the table.
 *
 * @param {string} name the module's name
 * @return {!Array<string>} the command names, in the table's order
 */
function commandsOf(name) {
  const commands = [];
  for (const [command, rule] of Object.entries(TITLE_COMMANDS)) {
    const modules = [rule.module];
    if (rule.moduleOfKind) {
      modules.push(...Object.values(rule.moduleOfKind));
    }
    if (rule.moduleInBlank) {
      modules.push(rule.moduleInBlank);
    }
    if (modules.includes(name)) {
      commands.push(command);
    }
  }
  return commands;
}

/**
 * A module, frozen, with its commands read from the table.
 *
 * @param {string} name
 * @param {string} label
 * @param {!Array<string>} needs
 * @return {!Readonly<!TitleModule>}
 */
function titleModule(name, label, needs) {
  return Object.freeze({
    name,
    label,
    needs: Object.freeze(needs),
    commands: Object.freeze(commandsOf(name)),
  });
}

/**
 * Every title module, by name, in the order they build on each other.
 *
 * @type {!Readonly<!Object<string, !Readonly<!TitleModule>>>}
 */
export const MODULES = Object.freeze({
  waybill: titleModule('waybill', 'Sea waybills and straight B/Ls', []),
  negotiable: titleModule('negotiable', 'Negotiable B/Ls', []),
  'blank-endorsement': titleModule('blank-endorsement', 'Blank endorsement', [
    'negotiable',
  ]),
  amendment: titleModule('amendment', 'Amendment', ['negotiable']),
  split: titleModule('split', 'Split', ['amendment']),
});

/** Every module's name, in `MODULES` order: all on, the default. */
export const ALL_MODULES = Object.freeze(Object.keys(MODULES));

/** The setting that lists the modules on in an install. */
export const MODULES_SETTING = 'LRFE_BL_MODULES';

/**
 * Whether the platform has a module of this name (its own entries only, never an object's
 * built-in names such as `toString`).
 *
 * @param {string} name
 * @return {boolean}
 */
function isKnown(name) {
  return Object.hasOwn(MODULES, name);
}

/**
 * The modules on in this install, from `LRFE_BL_MODULES` (comma-separated names; all of them when
 * not set or blank; `waybill` always). Read at start: an unknown name, an empty name or a module
 * without the one it needs stops the start with a message naming it.
 *
 * @param {!Object<string, (string|undefined)>=} source the settings, `process.env` by default
 * @return {!ReadonlyArray<string>} the names of the modules on, in `MODULES` order
 * @throws {Error} for an empty or unknown name, or a module whose needs are off
 */
export function modulesFromSettings(source = process.env) {
  const value = source[MODULES_SETTING]?.trim();
  if (!value) {
    return ALL_MODULES;
  }
  const names = new Set(value.split(',').map(name => name.trim()));
  const known = ALL_MODULES.join(', ');
  if (names.has('')) {
    throw new Error(
      `${MODULES_SETTING} has an empty name in its list. Known modules: ${known}`,
    );
  }
  const unknown = [...names].filter(name => !isKnown(name));
  if (unknown.length > 0) {
    throw new Error(
      `${MODULES_SETTING} names an unknown B/L module: ${unknown.join(', ')}. ` +
        `Known modules: ${known}`,
    );
  }
  names.add(ALWAYS_ON);
  for (const name of names) {
    for (const need of MODULES[name].needs) {
      if (!names.has(need)) {
        throw new Error(
          `${MODULES_SETTING} turns on ${name}, which needs ${need}: ` +
            `add ${need} or remove ${name}. Known modules: ${known}`,
        );
      }
    }
  }
  return Object.freeze(ALL_MODULES.filter(name => names.has(name)));
}

/**
 * The module that keeps a command's case off, given the modules on: the module itself, or the
 * most basic module it needs that is off. Null when it is on with everything it needs.
 *
 * @param {string} name the module of the command's case
 * @param {!ReadonlyArray<string>} modules the modules on
 * @return {?string}
 */
export function moduleOff(name, modules) {
  if (name === ALWAYS_ON || !isKnown(name)) {
    return null;
  }
  for (const need of MODULES[name].needs) {
    const off = moduleOff(need, modules);
    if (off !== null) {
      return off;
    }
  }
  if (!modules.includes(name)) {
    return name;
  }
  return null;
}
