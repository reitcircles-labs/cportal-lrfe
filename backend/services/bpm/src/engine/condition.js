import jsonLogic from 'json-logic-js';

/**
 * Conditions, assignee expressions and titles in process definitions are JsonLogic
 * ({"==": [{"var": "approval.outcome"}, "approved"]}), never code: definitions are data, and
 * JsonLogic can only read and combine the data it is handed.
 */
export function evaluate(rule, data) {
    if (rule === undefined) return undefined;
    return jsonLogic.apply(rule, data);
}

export function evaluateCondition(rule, data) {
    if (rule === true || rule === undefined) return true;
    return !!evaluate(rule, data);
}
