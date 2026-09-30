import { HttpException, HttpStatus, ArgumentsHost } from "@nestjs/common";
import { HttpExceptionFilter } from "./http-exception.filter";
import * as sentryModule from "./sentry";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeHost(json: jest.Mock, requestId?: string): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => ({
        status: (_code: number) => ({ json }),
      }),
      getRequest: () => (requestId ? { requestId } : {}),
    }),
  } as unknown as ArgumentsHost;
}

// ── Sentry mock ───────────────────────────────────────────────────────────────
// Spy on captureException so we can assert it is called only in the 500 branch.

jest.mock("./sentry", () => ({
  initSentry: jest.fn(),
  captureException: jest.fn(),
}));

// ── tests ─────────────────────────────────────────────────────────────────────

describe("HttpExceptionFilter", () => {
  let filter: HttpExceptionFilter;
  let json: jest.Mock;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    json = jest.fn();
    jest.clearAllMocks();
  });

  describe("HttpException branch", () => {
    it("returns the correct status for a 404", () => {
      const host = makeHost(json);
      filter.catch(new HttpException("Not found", HttpStatus.NOT_FOUND), host);
      expect(json).toHaveBeenCalledWith({ error: "Not found" });
    });

    it("does NOT call captureException for expected HttpExceptions (no alert fatigue)", () => {
      const host = makeHost(json);
      filter.catch(new HttpException("Bad request", HttpStatus.BAD_REQUEST), host);
      expect(sentryModule.captureException).not.toHaveBeenCalled();
    });

    it("surfaces class-validator array messages", () => {
      const host = makeHost(json);
      const body = { message: ["field must not be empty"], error: "Bad Request", statusCode: 400 };
      filter.catch(new HttpException(body, HttpStatus.BAD_REQUEST), host);
      expect(json).toHaveBeenCalledWith({
        error: "Validation failed",
        details: ["field must not be empty"],
      });
    });
  });

  describe("generic Error branch (500)", () => {
    it("returns 500 json for an unhandled Error", () => {
      const host = makeHost(json);
      filter.catch(new Error("boom"), host);
      expect(json).toHaveBeenCalledWith({ error: "boom" });
    });

    it("calls captureException with the Error instance (Sentry alerting)", () => {
      const host = makeHost(json);
      const err = new Error("unexpected failure");
      filter.catch(err, host);
      expect(sentryModule.captureException).toHaveBeenCalledTimes(1);
      expect(sentryModule.captureException).toHaveBeenCalledWith(err);
    });

    it("wraps non-Error throws and still calls captureException", () => {
      const host = makeHost(json);
      filter.catch("string throw", host);
      expect(sentryModule.captureException).toHaveBeenCalledTimes(1);
      const captured = (sentryModule.captureException as jest.Mock).mock.calls[0][0];
      expect(captured).toBeInstanceOf(Error);
    });

    it("returns 500 with fallback message for unknown throws", () => {
      const host = makeHost(json);
      filter.catch(null, host);
      expect(json).toHaveBeenCalledWith({ error: "Unknown error" });
    });

    it("propagates an express error's own numeric status instead of masking with 500", () => {
      const host = makeHost(json);
      const payloadTooLarge = Object.assign(new Error("request entity too large"), { status: 413 });

      filter.catch(payloadTooLarge, host);

      expect(json).toHaveBeenCalledWith({ error: "request entity too large" });
    });
  });

  describe("requestId propagation", () => {
    it("echoes requestId back on an HttpException when the request has one", () => {
      const host = makeHost(json, "req-abc-123");

      filter.catch(new HttpException("Not found", HttpStatus.NOT_FOUND), host);

      expect(json).toHaveBeenCalledWith({ error: "Not found", requestId: "req-abc-123" });
    });

    it("omits requestId entirely when the request has none", () => {
      const host = makeHost(json);

      filter.catch(new HttpException("Not found", HttpStatus.NOT_FOUND), host);

      expect(json).toHaveBeenCalledWith({ error: "Not found" });
      expect(json.mock.calls[0][0]).not.toHaveProperty("requestId");
    });

    it("does not add requestId to the 500 branch", () => {
      const host = makeHost(json, "req-abc-123");

      filter.catch(new Error("boom"), host);

      expect(json).toHaveBeenCalledWith({ error: "boom" });
    });
  });

  // ── issue #304: custom-shaped body allowlist ───────────────────────────────
  describe("custom-shaped body allowlist (issue #304)", () => {
    it("passes through the known-safe fields (error, intentId, minDstAmount, fillAmount)", () => {
      const host = makeHost(json);
      const { BadRequestException } = require("@nestjs/common");
      filter.catch(
        new BadRequestException({
          error: "fill amount below minimum",
          intentId: "abc-123",
          minDstAmount: "100",
          fillAmount: "90",
        }),
        host,
      );
      expect(json).toHaveBeenCalledWith({
        error: "fill amount below minimum",
        intentId: "abc-123",
        minDstAmount: "100",
        fillAmount: "90",
      });
    });

    it("strips unknown fields that are not in the allowlist", () => {
      const host = makeHost(json);
      const { BadRequestException } = require("@nestjs/common");
      filter.catch(
        new BadRequestException({
          error: "something went wrong",
          intentId: "abc-123",
          internalDebugField: "stack trace here",
          dbId: 42,
        }),
        host,
      );
      const body = json.mock.calls[0][0];
      expect(body.error).toBe("something went wrong");
      expect(body.intentId).toBe("abc-123");
      expect(body).not.toHaveProperty("internalDebugField");
      expect(body).not.toHaveProperty("dbId");
    });

    it("propagates requestId on a custom-shaped body", () => {
      const host = makeHost(json, "req-xyz-456");
      const { BadRequestException } = require("@nestjs/common");
      filter.catch(
        new BadRequestException({ error: "fill amount below minimum", intentId: "abc-123" }),
        host,
      );
      expect(json).toHaveBeenCalledWith({
        error: "fill amount below minimum",
        intentId: "abc-123",
        requestId: "req-xyz-456",
      });
    });

    it("omits undefined allowlisted fields from the response", () => {
      const host = makeHost(json);
      const { BadRequestException } = require("@nestjs/common");
      filter.catch(
        new BadRequestException({ error: "generic error" }),
        host,
      );
      const body = json.mock.calls[0][0];
      expect(body).not.toHaveProperty("intentId");
      expect(body).not.toHaveProperty("minDstAmount");
      expect(body).not.toHaveProperty("fillAmount");
    });
  });
});
