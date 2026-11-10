import {expect} from 'chai';

import {checkWorkflows} from '../src/sections/workflows.js';

/** A small but whole section: one definition, two acknowledgers, one description. */
function section() {
  return {
    definitions: [
      {
        key: 'cargo-release',
        name: 'Release of a cargo',
        startAt: 'start',
        nodes: {start: {type: 'start', next: 'done'}, done: {type: 'end'}},
      },
    ],
    auditAcknowledgers: [
      {task: 'clerk', role: 'clk'},
      {task: 'master', role: 'mst'},
    ],
    descriptions: {'audit-finding': 'A finding on a bill of lading.'},
  };
}

/** Expects the section, changed by `change`, to be refused with `message`. */
function refused(change, message) {
  const value = section();
  change(value);
  expect(() => checkWorkflows('demo', value)).to.throw(message);
}

describe('the workflows section of a domain pack (CB-3)', () => {
  it('takes an empty section, and a whole one', () => {
    expect(() => checkWorkflows('demo', {})).not.to.throw();
    expect(() => checkWorkflows('demo', section())).not.to.throw();
  });

  it('refuses a section that is not an object, or has an unknown field', () => {
    expect(() => checkWorkflows('demo', [])).to.throw(
      'Domain pack demo: "workflows" is not an object',
    );
    refused(s => (s.roles = []), 'workflows: unknown field "roles"');
  });

  it('refuses definitions without a valid, unique key, a name or nodes', () => {
    refused(s => (s.definitions = {}), '"definitions" is not a list');
    refused(s => (s.definitions = ['x']), 'definition 0 is not an object');
    refused(
      s => (s.definitions[0].key = 'Cargo release'),
      'definition 0 has no valid key ("Cargo release")',
    );
    refused(
      s => s.definitions.push({...s.definitions[0]}),
      'two definitions have the key "cargo-release"',
    );
    refused(
      s => delete s.definitions[0].name,
      'definition "cargo-release" has no name',
    );
    refused(
      s => (s.definitions[0].nodes = []),
      'definition "cargo-release" has no nodes',
    );
  });

  it('refuses audit acknowledgers without a valid, unique task or a role', () => {
    refused(
      s => (s.auditAcknowledgers = 'clk'),
      '"auditAcknowledgers" is not a list',
    );
    refused(
      s => (s.auditAcknowledgers[0].task = 'done'),
      'audit acknowledger 0 has no valid task name ("done")',
    );
    refused(
      s => (s.auditAcknowledgers[1].task = 'the master'),
      'audit acknowledger 1 has no valid task name ("the master")',
    );
    refused(
      s => (s.auditAcknowledgers[1].task = 'clerk'),
      'two audit acknowledgers have the task "clerk"',
    );
    refused(
      s => (s.auditAcknowledgers[0].role = ''),
      'audit acknowledger "clerk" has no role',
    );
  });

  it('refuses descriptions that are not texts', () => {
    refused(s => (s.descriptions = []), '"descriptions" is not an object');
    refused(
      s => (s.descriptions['audit-finding'] = 3),
      'the description of "audit-finding" is not a text',
    );
  });
});
