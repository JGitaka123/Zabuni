import { describe, expect, it } from "vitest";

import nextConfig from "../next.config.js";
import { resolvePublicApiOrigin } from "../lib/public-config.js";

describe("web foundation", () => {
  it("does not advertise the framework", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("fails closed when the production API origin is missing or insecure", () => {
    expect(() => resolvePublicApiOrigin(undefined, true)).toThrow(
      "NEXT_PUBLIC_API_URL is required in production"
    );
    expect(() => resolvePublicApiOrigin("http://api.example.com", true)).toThrow(
      "NEXT_PUBLIC_API_URL must use https:// in production"
    );
  });

  it("rejects API URLs that are not origin-only", () => {
    expect(() => resolvePublicApiOrigin("https://api.example.com/v1", true)).toThrow(
      "NEXT_PUBLIC_API_URL must contain only an origin"
    );
    expect(() => resolvePublicApiOrigin("https://user@api.example.com", true)).toThrow(
      "NEXT_PUBLIC_API_URL must contain only an origin"
    );
  });

  it("keeps the local fallback outside production", () => {
    expect(resolvePublicApiOrigin(undefined, false)).toBe("http://localhost:3001");
  });

  it("sets the browser security-header baseline", async () => {
    const entries = await nextConfig.headers?.();
    const headers = entries?.[0]?.headers ?? [];
    const values = new Map(headers.map((header) => [header.key, header.value]));
    expect(values.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(values.get("X-Content-Type-Options")).toBe("nosniff");
    expect(values.get("X-Frame-Options")).toBe("DENY");
  });
});
