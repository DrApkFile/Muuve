export class AppError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export function assert(condition: unknown, code: string, status = 400): asserts condition {
  if (!condition) throw new AppError(code, status);
}
