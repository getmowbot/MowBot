import { STATUS_CODES } from 'node:http';
import { type Problem, problemSchema } from '@mowbot/contract';

/** An error that maps to an RFC 9457 problem response. `code` becomes `urn:mowbot:problem:<code>`. */
export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

export function problemBody(
  status: number,
  code: string,
  detail?: string,
  extra: Partial<Problem> = {},
): Problem {
  return {
    type: `urn:mowbot:problem:${code}`,
    title: STATUS_CODES[status] ?? 'Error',
    status,
    ...(detail ? { detail } : {}),
    ...extra,
  };
}

/** Documented on every route so generated clients know the error shape. */
export const errorResponses = {
  '4xx': problemSchema,
  '5xx': problemSchema,
} as const;

export const unauthorized = (detail = 'Authentication required') =>
  new HttpProblem(401, 'unauthorized', detail);

export const forbidden = (detail = 'Missing required scope') =>
  new HttpProblem(403, 'forbidden', detail);

export const notFound = (detail = 'Resource not found') =>
  new HttpProblem(404, 'not_found', detail);
