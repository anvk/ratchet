// Safe to import in a browser: this file only imports an error class.

import { InvalidScheduleError } from "./workflowEngine.errors.ts";

/** A parsed cron expression: the values each field allows. */
export interface Cron {
  /** Allowed minutes, 0-59. */
  minutes: Set<number>;
  /** Allowed hours, 0-23. */
  hours: Set<number>;
  /** Allowed days of the month, 1-31. */
  daysOfMonth: Set<number>;
  /** Allowed months, 1-12. */
  months: Set<number>;
  /** Allowed days of the week, 0-6, where Sunday is 0. */
  daysOfWeek: Set<number>;
  /** Whether the day-of-month field was `*`. With anyDayOfWeek, decides how the two day fields combine. */
  anyDayOfMonth: boolean;
  /** Whether the day-of-week field was `*`. */
  anyDayOfWeek: boolean;
}

/** One cron field: its name for error messages and the values it accepts. */
interface CronFieldSpec {
  name: string;
  min: number;
  max: number;
}

/** The five cron fields, in the order they are written. */
const CRON_FIELDS: CronFieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  // 7 is accepted as a second spelling of Sunday and folded into 0 after parsing.
  { name: "day of week", min: 0, max: 7 },
];

const ONE_MINUTE_MS = 60_000;

/** Checks that a number written in a cron field is inside the field's range. */
function assertInRange({
  expression,
  spec,
  value,
}: {
  expression: string;
  spec: CronFieldSpec;
  value: number;
}) {
  if (value < spec.min || value > spec.max) {
    throw new InvalidScheduleError(
      `Cron "${expression}": ${spec.name} ${value} is out of range ${spec.min}-${spec.max}`,
    );
  }
}

/** Reads the number after a slash in a cron item, which must be a positive whole number. */
function parseStep({
  expression,
  spec,
  text,
}: {
  expression: string;
  spec: CronFieldSpec;
  text: string;
}) {
  if (!/^\d+$/.test(text) || Number(text) === 0) {
    throw new InvalidScheduleError(
      `Cron "${expression}": ${spec.name} step "${text}" must be a positive whole number`,
    );
  }
  return Number(text);
}

/** Expands one comma-separated item of a cron field (`*`, `n`, `a-b`, each with an optional step). */
function parseCronItem({
  expression,
  spec,
  item,
}: {
  expression: string;
  spec: CronFieldSpec;
  item: string;
}): number[] {
  if (item === "") {
    throw new InvalidScheduleError(
      `Cron "${expression}": ${spec.name} has an empty item in its list`,
    );
  }
  const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(.*))?$/.exec(item);
  if (!match) {
    throw new InvalidScheduleError(
      `Cron "${expression}": ${spec.name} "${item}" isn't supported; use *, numbers, ranges, steps and lists`,
    );
  }
  const [, base, startText, endText, stepText] = match;
  const step = stepText === undefined ? 1 : parseStep({ expression, spec, text: stepText });
  const start = base === "*" ? spec.min : Number(startText);
  // A lone number only spans to the end when it has a step (`5/20`).
  const end =
    base === "*"
      ? spec.max
      : endText !== undefined
        ? Number(endText)
        : stepText === undefined
          ? start
          : spec.max;
  assertInRange({ expression, spec, value: start });
  assertInRange({ expression, spec, value: end });
  if (start > end) {
    throw new InvalidScheduleError(
      `Cron "${expression}": ${spec.name} range ${start}-${end} starts after it ends`,
    );
  }
  const values: number[] = [];
  for (let value = start; value <= end; value += step) values.push(value);
  return values;
}

/** Expands one cron field into the values it allows. */
function parseCronField({
  expression,
  spec,
  text,
}: {
  expression: string;
  spec: CronFieldSpec;
  text: string;
}): Set<number> {
  const values = text.split(",").flatMap((item) => parseCronItem({ expression, spec, item }));
  return new Set(values);
}

/** Parses a five-field cron expression, or throws saying what is wrong with it. */
export function parseCron(expression: string): Cron {
  const texts = expression.trim().split(/\s+/);
  if (texts.length !== 5) {
    const found = expression.trim() === "" ? 0 : texts.length;
    throw new InvalidScheduleError(
      `Cron "${expression}": found ${found} fields, but five are needed (minute, hour, day of month, month, day of week)`,
    );
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = CRON_FIELDS.map((spec, i) =>
    parseCronField({ expression, spec, text: texts[i] }),
  );
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek: new Set([...daysOfWeek].map((day) => day % 7)),
    anyDayOfMonth: texts[2] === "*",
    anyDayOfWeek: texts[4] === "*",
  };
}

/**
 * Whether a date's day passes the two day fields. When both are restricted, either
 * one matching is enough; otherwise the restricted one decides.
 */
function dayMatches(cron: Cron, date: Date): boolean {
  const ofMonth = cron.daysOfMonth.has(date.getUTCDate());
  const ofWeek = cron.daysOfWeek.has(date.getUTCDay());
  if (cron.anyDayOfMonth && cron.anyDayOfWeek) return true;
  if (cron.anyDayOfMonth) return ofWeek;
  if (cron.anyDayOfWeek) return ofMonth;
  return ofMonth || ofWeek;
}

/**
 * The first minute strictly after `after` that the expression allows, in UTC.
 * Throws if there is none within five years.
 */
export function nextFireAfter({ cron: expression, after }: { cron: string; after: Date }): Date {
  const cron = parseCron(expression);
  const limit = new Date(after);
  limit.setUTCFullYear(limit.getUTCFullYear() + 5);
  let t = new Date(Math.floor(after.getTime() / ONE_MINUTE_MS) * ONE_MINUTE_MS + ONE_MINUTE_MS);
  while (t <= limit) {
    const [y, mo, d, h] = [t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours()];
    if (!cron.months.has(mo + 1)) {
      t = new Date(Date.UTC(y, mo + 1, 1));
    } else if (!dayMatches(cron, t)) {
      t = new Date(Date.UTC(y, mo, d + 1));
    } else if (!cron.hours.has(h)) {
      t = new Date(Date.UTC(y, mo, d, h + 1));
    } else if (!cron.minutes.has(t.getUTCMinutes())) {
      t = new Date(t.getTime() + ONE_MINUTE_MS);
    } else {
      return t;
    }
  }
  throw new InvalidScheduleError(`Cron "${expression}" never fires`);
}

/** Throws if the expression doesn't parse or never fires. */
export function assertCronFires(expression: string) {
  nextFireAfter({ cron: expression, after: new Date() });
}
