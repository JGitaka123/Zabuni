import type { MiddlewareHandler } from "hono";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cookie authentication needs a request-origin boundary in addition to CORS.
 * CORS controls which responses browser JavaScript may read; it does not stop a
 * hostile page from submitting a simple state-changing request with the user's
 * cookies. Better Auth protects its own routes, so this guard covers Zabuni's
 * custom browser mutations.
 */
export function requireTrustedBrowserOrigin(webOrigin: string): MiddlewareHandler {
  return async (context, next) => {
    if (
      safeMethods.has(context.req.method) ||
      context.req.path.startsWith("/auth/") ||
      context.req.header("cookie") === undefined
    ) {
      return next();
    }

    if (context.req.header("origin") !== webOrigin) {
      return context.json({ error: "browser_origin_denied" }, 403);
    }

    return next();
  };
}
