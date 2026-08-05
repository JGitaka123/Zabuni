import { describe, expect, it } from "vitest";

import { workerStatus } from "../src/index.js";

describe("worker foundation", () => {
  it("reports readiness", () => {
    expect(workerStatus).toBe("ready");
  });
});

