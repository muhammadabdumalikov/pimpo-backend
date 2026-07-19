import {HttpException} from '@nestjs/common';
import {ERROR_REGISTRY, ErrorCode} from './error-codes';

export type ErrorParams = Record<string, string | number | boolean | null>;

// Replaces `{token}` placeholders in a registry message with param values.
// Unknown tokens are left as-is so a missing param is visible rather than silent.
function interpolate(template: string, params?: ErrorParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

// The single exception type the whole app throws. It carries a stable machine
// code (localized by the frontend) plus optional params. The HTTP status and a
// developer-facing English message are resolved from ERROR_REGISTRY.
//
//   throw new AppException(ErrorCode.PRODUCT_NOT_FOUND);
//   throw new AppException(ErrorCode.PRODUCT_NOT_FOUND_BY_ID, { productId });
//
// The response body is shaped by AllExceptionsFilter.
export class AppException extends HttpException {
  public readonly code: ErrorCode;
  public readonly params?: ErrorParams;

  constructor(code: ErrorCode, params?: ErrorParams) {
    const def = ERROR_REGISTRY[code];
    const message = interpolate(def.message, params);
    super({code, message, params}, def.status);
    this.code = code;
    this.params = params;
  }
}
