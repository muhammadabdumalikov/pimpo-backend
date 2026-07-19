import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type {Response} from 'express';
import {AppException} from '../errors/app.exception';
import {ErrorCode, genericCodeForStatus} from '../errors/error-codes';

// Uniform error envelope for every failed request:
//   { statusCode, code, message, params? }
// - `code`    → stable machine code the frontend localizes (uz/ru/en).
// - `message` → English, developer/fallback only. Never localized here.
// - `params`  → interpolation values (e.g. { limit: 50 }) and, for validation
//                errors, the raw field messages under `fields`.
interface ErrorBody {
  statusCode: number;
  code: ErrorCode;
  message: string;
  params?: Record<string, unknown>;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const body = this.toBody(exception);
    res.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): ErrorBody {
    // 1) Our own exceptions already carry a code + params.
    if (exception instanceof AppException) {
      return {
        statusCode: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        ...(exception.params ? {params: exception.params} : {}),
      };
    }

    // 2) Built-in Nest HttpExceptions (guards, ValidationPipe, or throws not
    //    yet migrated) — derive a generic code from the status.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const rawMessage =
        typeof response === 'string'
          ? response
          : (response as {message?: string | string[]})?.message;

      // class-validator returns `message` as an array of field errors.
      const isValidation = Array.isArray(rawMessage);
      const message = isValidation
        ? (rawMessage as string[]).join(', ')
        : (rawMessage ?? exception.message);
      const code = isValidation
        ? ErrorCode.VALIDATION_ERROR
        : genericCodeForStatus(status);

      return {
        statusCode: status,
        code,
        message,
        ...(isValidation ? {params: {fields: rawMessage}} : {}),
      };
    }

    // 3) Anything else is an unhandled server error — log it, hide details.
    this.logger.error(
      exception instanceof Error ? exception.stack : String(exception),
    );
    return {
      statusCode: 500,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    };
  }
}
