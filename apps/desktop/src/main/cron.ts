/**
 * cron.ts — a minimal 5-field cron parser and scheduler.
 *
 * Why not a library: the whole feature is "fire this prompt on a schedule".
 * A dependency-free implementation keeps the supply chain small (this app
 * runs shell commands on the user's machine — every added dependency is a
 * genuine risk) and avoids the timezone-handling surprises that come with
 * larger scheduling packages.
 *
 * Supported syntax, per field: `*`, `N`, `A-B`, `A-B/S`, `*​/S`, and
 * comma-separated lists of those. Field order:
 *
 *     minute hour day-of-month month day-of-week
 *     0-59   0-23 1-31         1-12  0-6 (0 = Sunday)
 *
 * Deliberately unsupported: `@daily` aliases, `L`/`W`/`#` modifiers, and
 * seconds. The UI offers presets for common cases, so the long tail is not
 * worth the parsing surface.
 *
 * Day-of-month / day-of-week follow the POSIX rule: when BOTH are restricted
 * the match is a union (either may satisfy it), not an intersection. This
 * surprises people, but matching standard cron is less surprising overall.
 */

export interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
  /** True when the field was `*` — needed for the POSIX day-union rule. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const RANGES: Record<string, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 6],
};

/** Expand one cron field into the explicit list of values it matches. */
function parseField(raw: string, name: keyof typeof RANGES): number[] {
  const [min, max] = RANGES[name]!;
  const out = new Set<number>();

  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) throw new Error(`Empty value in "${name}" field`);

    const [spec, stepRaw] = token.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid step "${stepRaw}" in "${name}" field`);
    }

    let lo: number;
    let hi: number;
    if (spec === '*' || spec === undefined) {
      lo = min;
      hi = max;
    } else if (spec.includes('-')) {
      const [a, b] = spec.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(spec);
      hi = Number(spec);
    }

    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new Error(`Invalid value "${spec}" in "${name}" field`);
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`Value "${spec}" out of range ${min}-${max} in "${name}" field`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }

  return [...out].sort((a, b) => a - b);
}

/** Parse a 5-field cron expression. Throws a human-readable error. */
export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Expected 5 fields (minute hour day month weekday), got ${parts.length}`);
  }
  const [mi, ho, dom, mo, dow] = parts as [string, string, string, string, string];
  return {
    minute: parseField(mi, 'minute'),
    hour: parseField(ho, 'hour'),
    dayOfMonth: parseField(dom, 'dayOfMonth'),
    month: parseField(mo, 'month'),
    // Accept 7 as Sunday (common convention) by normalizing to 0.
    dayOfWeek: parseField(dow.replace(/\b7\b/g, '0'), 'dayOfWeek'),
    domRestricted: dom.trim() !== '*',
    dowRestricted: dow.trim() !== '*',
  };
}

/** True when the expression parses. Used for live validation in the UI. */
export function validateCron(expression: string): { ok: true } | { ok: false; error: string } {
  try {
    parseCron(expression);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Read wall-clock parts of `date` as observed in `timeZone`.
 *
 * `Intl.DateTimeFormat` is the only correct way to do this without a tz
 * database: it applies the zone's real DST rules for that instant.
 */
function partsInZone(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) map[p.type] = p.value;
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // Intl emits "24" for midnight under hour12:false; normalize to 0.
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    weekday: weekdays[map.weekday ?? 'Sun'] ?? 0,
  };
}

/** Does this instant satisfy the expression, evaluated in `timeZone`? */
export function matches(fields: CronFields, date: Date, timeZone: string): boolean {
  const p = partsInZone(date, timeZone);
  if (!fields.minute.includes(p.minute)) return false;
  if (!fields.hour.includes(p.hour)) return false;
  if (!fields.month.includes(p.month)) return false;

  const domOk = fields.dayOfMonth.includes(p.day);
  const dowOk = fields.dayOfWeek.includes(p.weekday);

  // POSIX: if both day fields are restricted, either one matching suffices.
  if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk;
  if (fields.domRestricted) return domOk;
  if (fields.dowRestricted) return dowOk;
  return true;
}

/** The system's IANA zone, used when a routine specifies none. */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Next firing instant strictly after `from`, or null if none is found.
 *
 * Scans minute by minute. Cheap integer comparisons make this a few
 * milliseconds per year scanned, and it runs only when a routine is saved or
 * fires — worth far more than an interval-jumping algorithm that is easy to
 * get subtly wrong around DST boundaries.
 *
 * The horizon is **5 years**, not one: `0 12 29 2 *` (Feb 29) can be up to
 * four years away, and a one-year limit silently reported "never runs" for a
 * perfectly valid leap-day schedule.
 *
 * Two guards on the day loop:
 *  - Days whose month/day cannot match are skipped a full day at a time,
 *    so a rare date costs ~1.8k iterations per year instead of 525k.
 *  - A skipped local hour (spring-forward) simply never matches, which is
 *    the correct behaviour: the routine fires on the next day that has it.
 */
const MAX_SCAN_YEARS = 5;

export function nextRun(
  expression: string,
  from: Date = new Date(),
  timeZone: string = systemTimeZone(),
): Date | null {
  const fields = parseCron(expression);
  // Start at the next whole minute; a cron never fires twice in one minute.
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const deadline = from.getTime() + MAX_SCAN_YEARS * 366 * 24 * 60 * 60 * 1000;

  while (cursor.getTime() <= deadline) {
    // Fast path: if this calendar day cannot match at all, jump a day.
    const p = partsInZone(cursor, timeZone);
    const domOk = fields.dayOfMonth.includes(p.day);
    const dowOk = fields.dayOfWeek.includes(p.weekday);
    const dayOk =
      fields.month.includes(p.month) &&
      (fields.domRestricted && fields.dowRestricted
        ? domOk || dowOk
        : fields.domRestricted
          ? domOk
          : fields.dowRestricted
            ? dowOk
            : true);

    if (!dayOk) {
      // Skip the rest of this LOCAL day in one jump.
      //
      // Subtlety worth stating: we must advance to the next local midnight,
      // not simply add 24h and truncate to UTC midnight. Truncating to UTC
      // midnight moves the cursor to a wall-clock time that may still be the
      // *same* local day (or, going the other way, overshoot a whole day) in
      // any zone with a non-zero offset — which silently skipped valid days.
      const minutesElapsedToday = p.hour * 60 + p.minute;
      const minutesToLocalMidnight = 24 * 60 - minutesElapsedToday;
      cursor.setMinutes(cursor.getMinutes() + minutesToLocalMidnight);
      cursor.setSeconds(0, 0);
      continue;
    }

    if (matches(fields, cursor, timeZone)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

/** Plain-English description of common patterns, for the routine list. */
export function describeCron(expression: string): string {
  try {
    const f = parseCron(expression);
    const two = (n: number) => String(n).padStart(2, '0');
    const time = () =>
      f.hour.length === 1 && f.minute.length === 1
        ? `${two(f.hour[0]!)}:${two(f.minute[0]!)}`
        : null;
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const t = time();

    if (!f.domRestricted && !f.dowRestricted && f.month.length === 12 && t) {
      return `Every day at ${t}`;
    }
    if (f.dowRestricted && !f.domRestricted && t) {
      if (f.dayOfWeek.length === 5 && f.dayOfWeek.every((d) => d >= 1 && d <= 5)) {
        return `Weekdays at ${t}`;
      }
      const days = f.dayOfWeek.map((d) => names[d]).join(', ');
      return `${days} at ${t}`;
    }
    if (f.domRestricted && f.dayOfMonth.length === 1 && t) {
      return `Day ${f.dayOfMonth[0]} of each month at ${t}`;
    }
    if (f.minute.length === 60 && f.hour.length === 24) return 'Every minute';
    if (f.minute.length === 1 && f.hour.length === 24) return `Hourly at :${two(f.minute[0]!)}`;
    return expression;
  } catch {
    return expression;
  }
}
