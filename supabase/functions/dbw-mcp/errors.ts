export type ErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "NO_DATA"
  | "PAGE_OUT_OF_RANGE"
  | "TOO_LARGE"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "UPSTREAM_TIMEOUT"
  | "INVALID_DBW_KEY"
  | "INTERNAL_ERROR";

export type ToolErrorOptions = {
  hint?: string;
  retryAfterSeconds?: number;
  details?: Record<string, unknown>;
};

export class ToolError extends Error {
  code: ErrorCode;
  hint?: string;
  retryAfterSeconds?: number;
  details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: ToolErrorOptions = {}) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.hint = options.hint;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.details = options.details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.retryAfterSeconds !== undefined ? { retry_after_seconds: this.retryAfterSeconds } : {}),
      ...(this.details ?? {}),
    };
  }
}

export function isToolError(err: unknown, code?: ErrorCode): err is ToolError {
  return err instanceof ToolError && (code === undefined || err.code === code);
}
