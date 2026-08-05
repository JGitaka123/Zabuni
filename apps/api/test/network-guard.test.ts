import net from "node:net";

import { describe, expect, it } from "vitest";

describe("offline test policy", () => {
  it("blocks non-loopback sockets", () => {
    expect(() => net.createConnection({ host: "example.com", port: 443 })).toThrow(
      "Network access is disabled in tests"
    );
  });
});

