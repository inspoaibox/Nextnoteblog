export class HttpError extends Error {
  status: number;
  data?: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}
export const notFound = (what = '内容') => new HttpError(404, `${what}不存在`);
export const badRequest = (message: string, data?: unknown) => new HttpError(400, message, data);
