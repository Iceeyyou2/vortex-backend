import { Controller, Get, Header, Inject, ForbiddenException, Headers } from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { MetricsService } from "./metrics.service";
import { AppConfig } from "../config/configuration";

@ApiTags("metrics")
@ApiSecurity("metrics-token")
@Controller("metrics")
export class MetricsController {
  constructor(
    @Inject(MetricsService) private readonly metricsService: MetricsService,
    private readonly configService: ConfigService<AppConfig>,
  ) {}

  /**
   * GET /metrics — Prometheus text-format metrics dump.
   *
   * Access control (issue #298): requires a `Authorization: Bearer <token>`
   * header that matches METRICS_TOKEN. When METRICS_TOKEN is empty (the
   * default in dev/test) every request is denied — callers must set
   * METRICS_TOKEN to enable the endpoint. In production the env-validation
   * schema enforces a minimum 16-character token, so this endpoint can never
   * be silently left open on a production deploy.
   *
   * Scrapers (Prometheus, Grafana Agent, etc.) should configure:
   *   bearer_token: <METRICS_TOKEN value>
   */
  @Get()
  @Header("Content-Type", "text/plain; charset=utf-8")
  async index(@Headers("authorization") authHeader?: string): Promise<string> {
    const token = this.configService.get<string>("metricsToken");

    // No token configured → endpoint is disabled.  Return 403 rather than
    // 401 to avoid leaking that an auth scheme exists at all to passive
    // scanners (RFC 7235 §3.1 says 401 MUST send WWW-Authenticate).
    if (!token) {
      throw new ForbiddenException("Metrics endpoint is not enabled");
    }

    // Constant-time-ish comparison is not feasible in pure JS without a
    // native crypto module; we at minimum avoid an early-exit string compare
    // that could be exploited as a timing oracle on this endpoint.
    const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!provided || provided !== token) {
      throw new ForbiddenException("Invalid or missing metrics token");
    }

    return this.metricsService.metrics();
  }
}
