export const BUSINESS_TIME_ZONE = "Africa/Nairobi";

declare const plainBusinessDateBrand: unique symbol;
export type PlainBusinessDate = string & {
  readonly [plainBusinessDateBrand]: true;
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAIROBI_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const NAIROBI_WEEKDAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  weekday: "short",
});

function assertValidInstant(instant: Date): void {
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError("A valid instant is required");
  }
}

export function plainBusinessDate(value: string): PlainBusinessDate {
  const match = DATE_PATTERN.exec(value);
  if (match === null) {
    throw new RangeError("Business date must use YYYY-MM-DD format");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const validationDate = new Date(Date.UTC(year, month - 1, day));

  if (
    validationDate.getUTCFullYear() !== year ||
    validationDate.getUTCMonth() !== month - 1 ||
    validationDate.getUTCDate() !== day
  ) {
    throw new RangeError("Business date is not a valid calendar date");
  }

  return value as PlainBusinessDate;
}

/** Returns the calendar date containing an instant in Africa/Nairobi. */
export function nairobiBusinessDate(instant: Date): PlainBusinessDate {
  assertValidInstant(instant);
  const parts = NAIROBI_DATE_FORMATTER.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return plainBusinessDate(`${part("year")}-${part("month")}-${part("day")}`);
}

export function isWeekdayBusinessDate(date: PlainBusinessDate): boolean {
  const weekday = NAIROBI_WEEKDAY_FORMATTER.format(businessDateStartUtc(date));
  return weekday !== "Sat" && weekday !== "Sun";
}

/**
 * Returns the Nairobi business date for an instant, rejecting weekend dates.
 * Public holidays are deliberately not inferred; Phase 0 defines weekdays only.
 */
export function weekdayBusinessDate(instant: Date): PlainBusinessDate {
  const date = nairobiBusinessDate(instant);
  if (!isWeekdayBusinessDate(date)) {
    throw new RangeError("The instant does not fall on a weekday business date");
  }
  return date;
}

/** Converts Nairobi midnight for a plain date to its UTC instant. */
export function businessDateStartUtc(date: PlainBusinessDate): Date {
  const validated = plainBusinessDate(date);
  const match = DATE_PATTERN.exec(validated);
  if (match === null) throw new RangeError("Business date must use YYYY-MM-DD format");

  return new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), -3),
  );
}

export function addWeekdayBusinessDays(
  date: PlainBusinessDate,
  days: number,
): PlainBusinessDate {
  if (!Number.isSafeInteger(days)) {
    throw new TypeError("Business-day offset must be a safe integer");
  }
  if (!isWeekdayBusinessDate(date)) {
    throw new RangeError("The starting date must be a weekday business date");
  }

  let remaining = Math.abs(days);
  const direction = days < 0 ? -1 : 1;
  let cursor = businessDateStartUtc(date);
  const wholeWeeks = Math.floor(remaining / 5);
  if (wholeWeeks > 0) {
    cursor = new Date(cursor.getTime() + direction * wholeWeeks * 7 * 86_400_000);
    remaining %= 5;
  }

  while (remaining > 0) {
    cursor = new Date(cursor.getTime() + direction * 86_400_000);
    const candidate = nairobiBusinessDate(cursor);
    if (isWeekdayBusinessDate(candidate)) {
      remaining -= 1;
    }
  }

  return nairobiBusinessDate(cursor);
}
