import { randomUUID } from "node:crypto";

import { verifyRequestSession, type AuthServer, type MembershipRuntime } from "@zabuni/auth";
import type { EmbeddingProvider } from "@zabuni/catalog";
import { tenants, users, type TenantRuntime } from "@zabuni/db";
import type { ErrorReporter, StructuredLogger } from "@zabuni/observability";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { requireTenantSession, type SessionVariables } from "./middleware/session.js";
import { requireExpectedContentType } from "./security/content-type.js";
import { requireTrustedBrowserOrigin } from "./security/origin.js";
import { registerCatalogRoutes } from "./catalog.js";

/** Header Better Auth is configured to read the client address from. */
export const CLIENT_IP_HEADER = "x-zabuni-client-ip";

/**
 * Shared bucket for callers whose address cannot be determined.
 *
 * Better Auth validates the value as an IP, so an "unknown" sentinel would be
 * discarded and silently disable limiting again. Everyone unidentified is
 * throttled together instead: fail closed, not open.
 */
const UNKNOWN_CLIENT_IP = "0.0.0.0";

/** Postgres surfaces its SQLSTATE on the driver error, sometimes via `cause`. */
function hasSqlState(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if (Reflect.get(current, "code") === code) return true;
    current = Reflect.get(current, "cause");
  }
  return false;
}

interface NodeRequestEnv {
  readonly incoming?: { readonly socket?: { readonly remoteAddress?: string } };
}

function resolveClientIp(
  context: {
    readonly req: { header: (name: string) => string | undefined };
    readonly env: unknown;
  },
  trustedProxyIpHeader: string | undefined
): string {
  // A forwarded header is only honoured when the deployment declares it, since
  // anyone can set one directly and would otherwise choose their own bucket.
  if (trustedProxyIpHeader !== undefined) {
    const forwarded = context.req.header(trustedProxyIpHeader);
    const first = forwarded?.split(",")[0]?.trim();
    if (first !== undefined && first !== "") return first;
  }
  const remote = (context.env as NodeRequestEnv | undefined)?.incoming?.socket?.remoteAddress;
  if (remote !== undefined && remote !== "") {
    // Node reports IPv4 clients as ::ffff:a.b.c.d over a dual-stack socket.
    return remote.startsWith("::ffff:") ? remote.slice("::ffff:".length) : remote;
  }
  return UNKNOWN_CLIENT_IP;
}

export interface AppDependencies {
  readonly auth: AuthServer;
  /** Forwarded-for style header to trust, when the API runs behind a proxy. */
  readonly trustedProxyIpHeader?: string;
  readonly memberships: MembershipRuntime;
  readonly tenants: TenantRuntime;
  readonly embeddingProvider?: EmbeddingProvider;
  /** Resolves when dependencies are usable; rejects to fail the readiness probe. */
  readonly readiness?: () => Promise<void>;
  readonly webOrigin: string;
  readonly telemetry?: {
    readonly logger: StructuredLogger;
    readonly errors: ErrorReporter;
  };
}

export function createApp(dependencies?: AppDependencies): Hono<{ Variables: SessionVariables }> {
  const app = new Hono<{ Variables: SessionVariables }>();
  // Liveness: the process is up. Deliberately free of dependency checks so a
  // database blip cannot cause an orchestrator to restart-loop a healthy process.
  app.get("/health", (context) => context.json({ status: "ok" }));
  if (dependencies === undefined) return app;

  const readiness = dependencies.readiness;
  if (readiness !== undefined) {
    // Readiness: safe to route traffic here. A failure sheds load instead of
    // serving requests that would fail at the database.
    app.get("/ready", async (context) => {
      try {
        await readiness();
        return context.json({ status: "ready" });
      } catch {
        return context.json({ status: "unready" }, 503);
      }
    });
  }

  if (dependencies.telemetry !== undefined) {
    const telemetry = dependencies.telemetry;
    app.use("*", async (context, next) => {
      const correlationId = randomUUID();
      context.set("correlationId", correlationId);
      const startedAt = performance.now();
      await next();
      // Telemetry must never fail the request. This runs after the response is
      // settled, so a throw here escapes past onError and the adapter answers
      // with an empty 500 -- and, because the logger is what failed, with no
      // record of why. Log writes really do fail: pino on a saturated pipe
      // raises EAGAIN, which turned ~2% of concurrent requests into 500s.
      try {
        telemetry.logger.info(
          "request_completed",
          { correlationId },
          {
            method: context.req.method,
            path: context.req.path,
            status: context.res.status,
            durationMs: Math.round(performance.now() - startedAt)
          }
        );
      } catch {
        /* a dropped log line is preferable to a failed request */
      }
    });
    app.onError((error, context) => {
      const correlationId = context.get("correlationId");
      // Same reasoning, and more important here: if reporting throws, the caller
      // would get an empty 500 instead of the correlation id they need to quote.
      try {
        telemetry.logger.error("request_failed", { correlationId }, { error });
      } catch {
        /* fall through to the response */
      }
      try {
        telemetry.errors.capture(error, { correlationId });
      } catch {
        /* fall through to the response */
      }
      return context.json({ error: "internal_error", correlationId }, 500);
    });
  }

  app.use(
    "*",
    cors({
      origin: dependencies.webOrigin,
      allowHeaders: ["Content-Type"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      credentials: true
    })
  );
  app.use("*", requireTrustedBrowserOrigin(dependencies.webOrigin));
  app.use("*", requireExpectedContentType);

  // Better Auth's rate limiter resolves the client only from headers and skips
  // limiting entirely when it cannot (`if (!ip) return`). Behind @hono/node-server
  // with no proxy header that is every request, so the configured limits never
  // applied and OTP sending was unthrottled. Resolve the client here and always
  // present a valid address, falling back to a shared bucket rather than none.
  app.on(["GET", "POST"], "/auth/*", async (context) => {
    const headers = new Headers(context.req.raw.headers);
    headers.set(CLIENT_IP_HEADER, resolveClientIp(context, dependencies.trustedProxyIpHeader));
    const forwarded = new Request(context.req.raw, { headers });
    return dependencies.auth.handler(forwarded);
  });

  app.post("/onboarding", async (context) => {
    const session = await verifyRequestSession(dependencies.auth, context.req.raw.headers);
    if (session === null) return context.json({ error: "unauthenticated" }, 401);
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid_legal_name" }, 400);
    }
    if (
      typeof body !== "object" ||
      body === null ||
      !("legalName" in body) ||
      typeof body.legalName !== "string" ||
      body.legalName.trim().length === 0 ||
      body.legalName.trim().length > 200
    ) {
      return context.json({ error: "invalid_legal_name" }, 400);
    }
    // Optional: provisioning falls back to the identity name, then the email
    // local part, because email sign-in leaves the identity name empty.
    const rawFullName = "fullName" in body ? body.fullName : undefined;
    if (
      rawFullName !== undefined &&
      (typeof rawFullName !== "string" || rawFullName.length > 200)
    ) {
      return context.json({ error: "invalid_full_name" }, 400);
    }
    const fullName = typeof rawFullName === "string" ? rawFullName.trim() : "";
    try {
      const provisioned = await dependencies.memberships.provision({
        identityId: session.identityId,
        legalName: body.legalName.trim(),
        ...(fullName === "" ? {} : { fullName })
      });
      return context.json(provisioned, 201);
    } catch (error) {
      // provision_tenant_owner signals its refusals with SQLSTATEs. Without this
      // a second submission -- a double-clicked form -- returned a 500, which
      // reads as a server fault rather than "you already have a tenant".
      if (hasSqlState(error, "23505")) {
        return context.json({ error: "tenant_already_provisioned" }, 409);
      }
      if (hasSqlState(error, "28000")) {
        return context.json({ error: "identity_not_verified" }, 403);
      }
      if (hasSqlState(error, "22023")) {
        return context.json({ error: "invalid_legal_name" }, 400);
      }
      throw error;
    }
  });

  app.get(
    "/session-proof",
    requireTenantSession(dependencies.auth, dependencies.memberships),
    async (context) => {
      const session = context.get("tenantSession");
      return dependencies.tenants.run(session.tenantId, async (database) => {
        const [proof] = await database
          .select({
            tenantId: tenants.id,
            tenantStatus: tenants.status,
            userId: users.id,
            role: users.role
          })
          .from(tenants)
          .innerJoin(users, and(eq(users.tenantId, tenants.id), eq(users.id, session.userId)))
          .where(eq(tenants.id, session.tenantId));
        if (proof === undefined) return context.json({ error: "tenant_access_denied" }, 403);
        return context.json({ authenticated: true, ...proof });
      });
    }
  );
  registerCatalogRoutes(app, dependencies);
  return app;
}
