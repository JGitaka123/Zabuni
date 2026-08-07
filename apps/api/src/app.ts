import { randomUUID } from "node:crypto";

import { verifyRequestSession, type AuthServer, type MembershipRuntime } from "@zabuni/auth";
import type { EmbeddingProvider } from "@zabuni/catalog";
import { tenants, users, type TenantRuntime } from "@zabuni/db";
import type { ErrorReporter, StructuredLogger } from "@zabuni/observability";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { requireTenantSession, type SessionVariables } from "./middleware/session.js";
import { registerCatalogRoutes } from "./catalog.js";

export interface AppDependencies {
  readonly auth: AuthServer;
  readonly memberships: MembershipRuntime;
  readonly tenants: TenantRuntime;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly webOrigin: string;
  readonly telemetry?: {
    readonly logger: StructuredLogger;
    readonly errors: ErrorReporter;
  };
}

export function createApp(dependencies?: AppDependencies): Hono<{ Variables: SessionVariables }> {
  const app = new Hono<{ Variables: SessionVariables }>();
  app.get("/health", (context) => context.json({ status: "ok" }));
  if (dependencies === undefined) return app;

  if (dependencies.telemetry !== undefined) {
    const telemetry = dependencies.telemetry;
    app.use("*", async (context, next) => {
      const correlationId = randomUUID();
      context.set("correlationId", correlationId);
      const startedAt = performance.now();
      await next();
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
    });
    app.onError((error, context) => {
      const correlationId = context.get("correlationId");
      telemetry.logger.error("request_failed", { correlationId }, { error });
      telemetry.errors.capture(error, { correlationId });
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

  app.on(["GET", "POST"], "/auth/*", (context) => dependencies.auth.handler(context.req.raw));

  app.post("/onboarding", async (context) => {
    const session = await verifyRequestSession(dependencies.auth, context.req.raw.headers);
    if (session === null) return context.json({ error: "unauthenticated" }, 401);
    const body: unknown = await context.req.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("legalName" in body) ||
      typeof body.legalName !== "string" ||
      body.legalName.trim().length === 0
    ) {
      return context.json({ error: "invalid_legal_name" }, 400);
    }
    const provisioned = await dependencies.memberships.provision({
      identityId: session.identityId,
      legalName: body.legalName.trim()
    });
    return context.json(provisioned, 201);
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
