/**
 * The title engine of the shipping pack (CB-30, docs/title-states.md), published as
 * `@lrfe/domain-shipping/title`: the B/L state machine, who may run each command and the modules
 * an install switches on (CB-38), and the endorsee a B/L is written out with (CB-37). Pure code:
 * no store, no service.
 */
export {END_STATES, KINDS, STATES, TITLE_COMMANDS, kindOf} from './table.js';
export {
  CARGO_PART_ARGUMENTS,
  TitleRefusal,
  allowedCommands,
  applyTitleCommand,
} from './engine.js';
export {endorseeOf} from './endorsee.js';
export {MODULES, MODULES_SETTING, modulesFromSettings} from './modules.js';
export {TITLE_WORDING} from './wording.js';
