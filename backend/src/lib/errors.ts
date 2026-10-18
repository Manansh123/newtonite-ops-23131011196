// Every expected failure is an AppError; the error middleware turns it into JSON.
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, extra?: Record<string, unknown>) => new AppError(400, 'BAD_REQUEST', msg, extra);
export const unauthorized = (msg = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'You do not have permission to do this') => new AppError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg);
/** `latest` lets the client reconcile without another round trip. */
export const conflict = (code: string, msg: string, latest?: unknown) =>
  new AppError(409, code, msg, latest === undefined ? {} : { latest });
export const unprocessable = (code: string, msg: string) => new AppError(422, code, msg);
