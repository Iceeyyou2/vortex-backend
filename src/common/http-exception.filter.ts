import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import { captureException } from "./sentry";
import { logger } from "./logger";

interface JsonResponse {
  status: (code: number) => { json: (body: unknown) => void };
  setHeader?: (name: string, value: string) => void;
}

interface RequestWithId {
  requestId?: string;
}

/**
 * Some 503s are transient and tell the client when to come back (an emergency
 * pause, a shedding load-shed). An exception may expose `retryAfterSeconds` to
 * have the `Retry-After` header set alongside the body.
 */
function setRetryAfter(response: JsonResponse, exception: unknown): void {
  const retryAfter = (exception as { retryAfterSeconds?: unknown })?.retryAfterSeconds;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
    response.setHeader?.("Retry-After", String(Math.ceil(retryAfter)));
  }
}

function addRequestId(body: Record<string, unknown>, requestId?: string): Record<string, unknown> {
  if (requestId) body.requestId = requestId;
  return body;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<JsonResponse>();
    const request = host.switchToHttp().getRequest<RequestWithId>();
    const requestId = request.requestId;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      setRetryAfter(response, exception);

      if (typeof body === "string") {
        response.status(status).json(addRequestId({ error: body }, requestId));
        return;
      }

      if (typeof body === "object" && body !== null) {
        const b = body as Record<string, unknown>;

        if (Array.isArray(b.message)) {
          response.status(status).json(
            addRequestId({ error: "Validation failed", details: b.message }, requestId),
          );
          return;
        }

        // Custom-shaped bodies passed directly to an exception constructor,
        // e.g. new BadRequestException({ error: "...", fillAmount, minDstAmount })
        //
        // Audit note (issue #304): rather than passing the raw body verbatim we
        // extract only the fields that are intentionally public.  The allowlist
        // is deliberately narrow — every new field a caller wants to surface to
        // the client must be added here explicitly, which makes "what can leak?"
        // answerable with a single grep.
        //
        // Kept fields:
        //   error          — the human-readable error description (always safe)
        //   intentId       — identifies the affected intent (safe to return)
        //   minDstAmount   — data-integrity constraint value (safe to return)
        //   fillAmount     — solver-supplied fill amount (safe to return)
        if (typeof b.error === "string" && !b.statusCode) {
          const safeBody: Record<string, unknown> = { error: b.error };
          if (b.intentId !== undefined) safeBody.intentId = b.intentId;
          if (b.minDstAmount !== undefined) safeBody.minDstAmount = b.minDstAmount;
          if (b.fillAmount !== undefined) safeBody.fillAmount = b.fillAmount;
          response.status(status).json(addRequestId(safeBody, requestId));
          return;
        }

        if (typeof b.message === "string") {
          response.status(status).json(addRequestId({ error: b.message }, requestId));
          return;
        }
      }

      response.status(status).json(addRequestId({ error: exception.message }, requestId));
      return;
    }

    const err = exception instanceof Error ? exception : new Error("Unknown error");

    // Express/body-parser errors (e.g. PayloadTooLargeError) carry a numeric
    // `status` field.  Propagate it as-is instead of masking with 500.
    const httpStatus = (exception as Record<string, unknown>)?.status;
    if (typeof httpStatus === "number" && httpStatus >= 400 && httpStatus < 600) {
      response.status(httpStatus).json({ error: err.message || "Request error" });
      return;
    }

    logger.error(err.stack ?? err.message);
    // Alert on-call engineers — only fires for unexpected exceptions, not
    // routine HttpExceptions, so alert fatigue on 404 / 400 is avoided.
    captureException(err);
    response.status(500).json({ error: err.message || "Internal server error" });
  }
}
