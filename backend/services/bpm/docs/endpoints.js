// What the generated openapi.yaml says about each route; paths, parameters, request bodies and
// access rules come from the routes themselves. Regenerate with `npm run docs` in backend/.
//
//   'METHOD /path': { summary, description?, tag, status? (success code), auth? (routes without a guard) }
//   auth: 'public' | 'refresh-cookie' | 'signed-link'

export default {
    title: 'bpm',
    description: 'Workflow engine: process definitions, running instances, and the task inbox with four-eyes approvals. ' +
        'Who may start a process, or do or approve a task, is set per process definition and checked by the engine (403 otherwise).',
    tags: {
        Processes: 'Process definitions and starting instances.',
        Instances: 'Running and finished process instances.',
        Tasks: "The signed-in user's task inbox.",
        Service: 'Health.'
    },
    routes: {
        'GET /health': { tag: 'Service', summary: 'Health check', auth: 'public' },

        'GET /processes': { tag: 'Processes', summary: 'Deployed process definitions', description: '`{ processes: [{ key, name, version, description, start, variables }] }`.' },
        'POST /processes/{key}/instances': {
            tag: 'Processes', status: 201, summary: 'Start a process',
            description: 'Body `{ variables }`, as the definition describes. E.g. request a correction to a filed document: key `document-amendment`, ' +
                'variables `{ documentId, expectedVersion, reason, changes: [{ k, v }] }`. The definition says which permissions or services may start it.'
        },

        'GET /instances': { tag: 'Instances', summary: 'List instances', description: '`{ items, total }`. `mine=true`: only those you started.' },
        'GET /instances/{id}': { tag: 'Instances', summary: 'One instance with its variables, tasks and history' },
        'POST /instances/{id}/cancel': { tag: 'Instances', summary: 'Cancel an active instance', description: 'Optional `{ reason }`. Allowed for whoever started it, and for holders of the definition\'s manage permission (verify.file for document-amendment). Only active or failed instances.' },
        'POST /instances/{id}/retry': { tag: 'Instances', summary: 'Retry an instance that stopped with an error', description: 'Resumes from the step that failed.' },

        'GET /tasks': { tag: 'Tasks', summary: 'My inbox', description: '`{ tasks }`: open tasks you may do and tasks you have claimed, with `overdue` and the related `document`.' },
        'GET /tasks/{id}': { tag: 'Tasks', summary: 'One task with its input' },
        'POST /tasks/{id}/claim': { tag: 'Tasks', summary: 'Claim a task so others do not work on it' },
        'POST /tasks/{id}/release': { tag: 'Tasks', summary: 'Give a claimed task back' },
        'POST /tasks/{id}/complete': {
            tag: 'Tasks', summary: 'Complete a task',
            description: 'Body `{ output }`. For the document-amendment approval: `{ output: { outcome: "approved" | "rejected", comment } }`, comment required when rejecting. Four-eyes: the person who requested a change cannot approve it. Returns `{ task, instance }`.'
        }
    }
};
