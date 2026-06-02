import { test, expect } from "bun:test";
import { parseDateTime } from "./types.ts";

test("RFC3339 with offset passes through, normalizing to include seconds", () => {
  expect(parseDateTime("2026-02-14T10:00+01:00")).toBe("2026-02-14T10:00:00+01:00");
  expect(parseDateTime("2026-02-14T10:00:30+01:00")).toBe("2026-02-14T10:00:30+01:00");
});

test("ISO datetime without offset gets a local offset appended", () => {
  expect(parseDateTime("2026-02-14T10:00")).toMatch(
    /^2026-02-14T10:00:00[+-]\d{2}:\d{2}$/,
  );
});

test("space-separated date and time is accepted", () => {
  expect(parseDateTime("2026-02-14 10:00")).toMatch(
    /^2026-02-14T10:00:00[+-]\d{2}:\d{2}$/,
  );
});

test("date-only input is treated as an all-day date", () => {
  expect(parseDateTime("2026-03-10")).toBe("2026-03-10");
});

test("time-only input uses today's date with an offset", () => {
  expect(parseDateTime("09:30")).toMatch(
    /^\d{4}-\d{2}-\d{2}T09:30:00[+-]\d{2}:\d{2}$/,
  );
});

test("unparseable input throws", () => {
  expect(() => parseDateTime("not a date")).toThrow();
});
