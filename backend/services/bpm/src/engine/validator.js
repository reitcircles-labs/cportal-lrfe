import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { BadRequestError } from '@lrfe/common';

export const NODE_TYPES = ['start', 'humanTask', 'serviceTask', 'exclusiveGateway', 'parallelGateway', 'join', 'multiInstanceTask', 'miEnd', 'end'];

// removeAdditional: true strips unknown keys only where a schema says additionalProperties: false
const ajv = new Ajv({ allErrors: true, useDefaults: true, removeAdditional: true });
addFormats(ajv);

const invalid = (msg) => new BadRequestError(`Invalid process definition: ${msg}`);
const nodeError = (id, msg) => invalid(`node "${id}" ${msg}`);

/**
 * Structural validation (ported from cportal-be/services/bpm, extended):
 *   {
 *     key, name,
 *     start:      { perm?: 'verify.edit', services?: ['intake'] }   who may start an instance
 *     managePerm: 'verify.file'                                     may cancel or retry any instance
 *     businessKey: <JsonLogic>                                      at most one active instance per key
 *     variables:  <JSON schema>                                     validated at start
 *     precheck:   { connector }   runs before the instance is created; errors reject the start
 *     startAt, nodes: { id: node }
 *   }
 * humanTask: assignee { perm | role | user(JsonLogic) }, exclude [JsonLogic → user id],
 *            outcomes [..], requireCommentFor [..], outputVar, dueInHours, title (string | JsonLogic)
 * serviceTask: connector (must exist), input, outputVar
 * end: outcome — the instance's outcome when this end completes it
 */
export function validateDefinition(def, { connectors = {} } = {}) {
    if (!def || typeof def !== 'object') throw invalid('must be an object');
    if (!/^[a-z][a-z0-9-]*$/.test(def.key || '')) throw invalid('"key" must be kebab-case');
    if (!def.name) throw invalid('"name" is required');
    if (!def.start || (!def.start.perm && !(def.start.services || []).length)) throw invalid('"start" needs a perm and/or services');
    if (def.variables) {
        try {
            ajv.compile(def.variables);
        } catch (err) {
            throw invalid(`"variables" is not a valid JSON schema: ${err.message}`);
        }
    }
    if (def.precheck && !connectors[def.precheck.connector]) throw invalid(`"precheck" uses unknown connector "${def.precheck.connector}"`);
    const { startAt, nodes } = def;
    if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) throw invalid('missing "nodes" map');
    if (!nodes[startAt]) throw invalid(`"startAt" references unknown node "${startAt}"`);

    const need = (id, node, field) => {
        if (node[field] === undefined || node[field] === null) throw nodeError(id, `is missing "${field}"`);
    };
    const ref = (id, target, label) => {
        if (!nodes[target]) throw nodeError(id, `${label} references unknown node "${target}"`);
    };
    const connector = (id, name) => {
        if (!connectors[name]) throw nodeError(id, `uses unknown connector "${name}"`);
    };

    for (const [id, node] of Object.entries(nodes)) {
        if (!NODE_TYPES.includes(node.type)) throw nodeError(id, `has unknown type "${node.type}"`);
        switch (node.type) {
            case 'start':
            case 'join':
                need(id, node, 'next');
                ref(id, node.next, '"next"');
                break;
            case 'humanTask': {
                need(id, node, 'assignee');
                need(id, node, 'next');
                ref(id, node.next, '"next"');
                const kinds = ['perm', 'role', 'user'].filter(k => node.assignee[k] !== undefined);
                if (kinds.length !== 1) throw nodeError(id, 'assignee must have exactly one of perm, role, user');
                if (node.exclude !== undefined && !Array.isArray(node.exclude)) throw nodeError(id, '"exclude" must be a list');
                if (node.outcomes !== undefined && (!Array.isArray(node.outcomes) || !node.outcomes.length)) throw nodeError(id, '"outcomes" must be a non-empty list');
                if (node.requireCommentFor && !(node.requireCommentFor || []).every(o => (node.outcomes || []).includes(o))) {
                    throw nodeError(id, '"requireCommentFor" must only name listed outcomes');
                }
                break;
            }
            case 'serviceTask':
                need(id, node, 'connector');
                need(id, node, 'next');
                ref(id, node.next, '"next"');
                connector(id, node.connector);
                break;
            case 'exclusiveGateway':
                if (!Array.isArray(node.cases) || !node.cases.length) throw nodeError(id, '"cases" must be a non-empty list');
                node.cases.forEach(c => ref(id, c.next, 'a case\'s "next"'));
                if (node.default) ref(id, node.default, '"default"');
                break;
            case 'parallelGateway':
                if (!Array.isArray(node.next) || node.next.length < 2) throw nodeError(id, '"next" must list at least 2 nodes');
                node.next.forEach(n => ref(id, n, '"next"'));
                break;
            case 'multiInstanceTask':
                for (const f of ['collection', 'elementVar', 'start', 'completionCondition', 'next']) need(id, node, f);
                ref(id, node.start, '"start"');
                ref(id, node.next, '"next"');
                connector(id, node.collection);
                break;
            case 'miEnd':
                need(id, node, 'outcome');
                break;
            case 'end':
                break;
        }
    }
    return true;
}

const compiled = new WeakMap();

/** Validate (and apply defaults to) a start request's variables against the definition's schema. */
export function validateVariables(def, variables) {
    if (!def.variables) return variables;
    let validate = compiled.get(def);
    if (!validate) {
        validate = ajv.compile(def.variables);
        compiled.set(def, validate);
    }
    const data = structuredClone(variables ?? {});
    if (!validate(data)) {
        const msg = validate.errors.map(e => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
        throw new BadRequestError(`Invalid variables: ${msg}`);
    }
    return data;
}
