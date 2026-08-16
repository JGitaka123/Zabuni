import type { MiddlewareHandler } from "hono";

const jsonMutationPaths = [
  /^\/onboarding$/u,
  /^\/catalog\/matches(?:\/confirm)?$/u,
  /^\/catalog\/aliases$/u,
  /^\/catalog\/items$/u,
  /^\/catalog\/items\/[^/]+$/u,
  /^\/catalog\/items\/[^/]+\/tax-class$/u,
  /^\/catalog\/imports\/[^/]+\/rows\/[^/]+\/tax-class$/u
];

function mediaTypeOf(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US");
}

function expectedMediaType(method: string, path: string): string | undefined {
  if (
    method === "POST" &&
    (path === "/catalog/imports/preview" || path === "/catalog/imports/inspect")
  ) {
    return "multipart/form-data";
  }
  if (
    (method === "POST" || method === "PUT") &&
    jsonMutationPaths.some((rule) => rule.test(path))
  ) {
    return "application/json";
  }
  return undefined;
}

/** Enforces the declared media type before any custom mutation parses a body. */
export const requireExpectedContentType: MiddlewareHandler = async (context, next) => {
  const expected = expectedMediaType(context.req.method, context.req.path);
  if (expected !== undefined && mediaTypeOf(context.req.header("content-type")) !== expected) {
    return context.json({ error: "unsupported_media_type" }, 415);
  }
  return next();
};
