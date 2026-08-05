import { describe, expect, it } from "vitest";

import {
  addWeekdayBusinessDays,
  businessDateStartUtc,
  isWeekdayBusinessDate,
  nairobiBusinessDate,
  plainBusinessDate,
  weekdayBusinessDate,
} from "../src/dates.js";

describe("Nairobi business dates", () => {
  it("derives dates using the Africa/Nairobi boundary", () => {
    expect(nairobiBusinessDate(new Date("2026-08-02T20:59:59.999Z"))).toBe("2026-08-02");
    expect(nairobiBusinessDate(new Date("2026-08-02T21:00:00.000Z"))).toBe("2026-08-03");
    expect(businessDateStartUtc(plainBusinessDate("2026-08-03")).toISOString()).toBe(
      "2026-08-02T21:00:00.000Z",
    );
  });

  it("validates plain dates and instants", () => {
    expect(plainBusinessDate("2024-02-29")).toBe("2024-02-29");
    expect(() => plainBusinessDate("2023-02-29")).toThrow("valid calendar date");
    expect(() => plainBusinessDate("03-08-2026")).toThrow("YYYY-MM-DD");
    expect(() => nairobiBusinessDate(new Date(Number.NaN))).toThrow("valid instant");
    expect(() => businessDateStartUtc("bad" as never)).toThrow("YYYY-MM-DD");
    expect(() => businessDateStartUtc("2026-02-31" as never)).toThrow("valid calendar date");
  });

  it("identifies and explicitly requires weekday business dates", () => {
    const monday = plainBusinessDate("2026-08-03");
    const sunday = plainBusinessDate("2026-08-02");

    expect(isWeekdayBusinessDate(monday)).toBe(true);
    expect(isWeekdayBusinessDate(sunday)).toBe(false);
    expect(weekdayBusinessDate(new Date("2026-08-03T08:00:00Z"))).toBe(monday);
    expect(() => weekdayBusinessDate(new Date("2026-08-02T08:00:00Z"))).toThrow(
      "weekday business date",
    );
  });

  it("adds and subtracts weekdays across weekends", () => {
    expect(addWeekdayBusinessDays(plainBusinessDate("2026-07-31"), 1)).toBe("2026-08-03");
    expect(addWeekdayBusinessDays(plainBusinessDate("2026-08-03"), -1)).toBe("2026-07-31");
    expect(addWeekdayBusinessDays(plainBusinessDate("2026-08-03"), 0)).toBe("2026-08-03");
    expect(() => addWeekdayBusinessDays(plainBusinessDate("2026-08-03"), 1.5)).toThrow(
      "safe integer",
    );
    expect(() => addWeekdayBusinessDays(plainBusinessDate("2026-08-02"), 1)).toThrow(
      "starting date",
    );
    expect(addWeekdayBusinessDays(plainBusinessDate("2026-08-03"), 1_000_000)).toBe(
      "5859-08-29",
    );
  });
});
