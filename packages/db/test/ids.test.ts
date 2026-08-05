import { describe, expect, it } from "vitest";

import { createEntityId, isUuidV7 } from "../src/ids.js";

describe("application-generated entity IDs", () => {
  it("creates valid UUIDv7 values", () => {
    expect(isUuidV7(createEntityId())).toBe(true);
  });

  it("rejects other UUID versions and malformed input", () => {
    expect(isUuidV7("00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(isUuidV7("not-a-uuid")).toBe(false);
  });

  it("is time ordered for sequential generation", () => {
    const first = createEntityId();
    const second = createEntityId();

    expect(first < second).toBe(true);
  });
});
