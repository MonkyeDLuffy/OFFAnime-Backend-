/**
 * Wraps an async Express handler so rejected promises are forwarded to
 * `next(err)` and handled by the centralized error handler.
 *
 * Without this, an unhandled rejection inside an `async` route handler would
 * hang the request instead of producing a proper error response.
 *
 * Usage:
 *   router.get('/x', asyncHandler(async (req, res) => { ... }));
 *
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<unknown>} handler
 * @returns {import('express').RequestHandler}
 */
export function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
