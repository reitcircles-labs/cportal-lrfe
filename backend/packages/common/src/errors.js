export const STATUS_TEXT = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    408: 'Request Timeout',
    409: 'Conflict',
    413: 'Payload Too Large',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout'
};

/** Base error: services throw these and the shared error handler turns them into responses. */
export class AppError extends Error {
    constructor(statusCode, message, details) {
        super(message);
        this.name = this.constructor.name;
        this.statusCode = statusCode;
        this.details = details;
    }
}

export class BadRequestError extends AppError {
    constructor(message = 'Bad request', details) { super(400, message, details); }
}
export class UnauthorizedError extends AppError {
    constructor(message = 'Authentication required', details) { super(401, message, details); }
}
export class ForbiddenError extends AppError {
    constructor(message = 'Not permitted', details) { super(403, message, details); }
}
export class NotFoundError extends AppError {
    constructor(message = 'Not found', details) { super(404, message, details); }
}
export class ConflictError extends AppError {
    constructor(message = 'Conflict', details) { super(409, message, details); }
}

/**
 * Fastify error handler. Same response shape as cportal-be's handleError(), minus the raw
 * `error` object (which leaked stack traces and internals) — 5xx messages are replaced.
 */
export function errorHandler(error, request, reply) {
    let statusCode = error.statusCode ?? 500;
    if (error.validation) statusCode = 400;
    if (!STATUS_TEXT[statusCode]) statusCode = 500;
    if (statusCode >= 500) request.log.error(error);

    const internal = statusCode >= 500 && !(error instanceof AppError);
    reply.status(statusCode).send({
        status: STATUS_TEXT[statusCode],
        message: internal ? 'An unexpected error occurred while making the request. Please try again.' : error.message,
        ...(error.details !== undefined && !internal ? { details: error.details } : {}),
        timestamp: new Date().toISOString(),
        path: request.url
    });
}
