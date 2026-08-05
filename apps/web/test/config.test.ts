import { describe, expect, it } from "vitest";

import nextConfig from "../next.config.js";

describe("web foundation", () => {
  it("does not advertise the framework", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
