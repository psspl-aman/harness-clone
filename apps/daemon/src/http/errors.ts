import type { ApiError } from '@ai-harness/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);
export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);

/** Uniform `{ error: { code, message, details? } }` responses. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    let status = 500;
    let body: ApiError;
    if (err instanceof ZodError) {
      status = 400;
      body = {
        error: {
          code: 'VALIDATION',
          message: err.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; '),
          details: err.issues,
        },
      };
    } else if (err instanceof AppError) {
      status = err.statusCode;
      body = { error: { code: err.code, message: err.message, details: err.details } };
    } else if ('statusCode' in err && typeof err.statusCode === 'number' && err.statusCode < 500) {
      status = err.statusCode;
      body = { error: { code: (err as FastifyError).code ?? 'BAD_REQUEST', message: err.message } };
    } else {
      req.log.error({ err }, 'unhandled error');
      body = { error: { code: 'INTERNAL', message: 'Internal server error' } };
    }
    void reply.status(status).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    void reply
      .status(404)
      .send({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found` } });
  });
}
