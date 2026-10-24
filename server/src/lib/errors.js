export class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const badRequest = (m = 'Bad request', details) => new HttpError(400, m, 'bad_request', details);
export const unauthorized = (m = 'Please log in') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'You do not have permission to do that', code = 'forbidden') => new HttpError(403, m, code);
export const notFound = (m = 'Not found') => new HttpError(404, m, 'not_found');
export const conflict = (m = 'Conflict', code = 'conflict') => new HttpError(409, m, code);

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
