/**
 * cron-test.ts — offline guards for the routine scheduler.
 *
 * Scheduling bugs are silent: a routine simply never fires, or fires at the
 * wrong hour, and nobody notices for days. These assertions pin the parser,
 * the POSIX day-union rule, DST behaviour, and `nextRun`.
 *
 * Run: npm run test:cron --workspace @ghostbot/examples-cli
 */
import {
  describeCron,
  matches,
  nextRun,
  parseCron,
  validateCron,
} from '@ghostbot/runtime';

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq<T>(label: string, actual: T, expected: T): void {
  check(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

/** Build a UTC instant; cron matching is then evaluated in a named zone. */
function utc(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(Date.UTC(y, mo - 1, d, h, mi, 0, 0));
}

console.log('\n[parse] field expansion');
{
  const f = parseCron('0 9 * * *');
  eq('minute [0]', f.minute.join(','), '0');
  eq('hour [9]', f.hour.join(','), '9');
  eq('dom unrestricted', f.domRestricted, false);
  eq('dow unrestricted', f.dowRestricted, false);

  const step = parseCron('*/15 * * * *');
  eq('*/15 expands', step.minute.join(','), '0,15,30,45');

  const range = parseCron('0 9-17 * * *');
  eq('9-17 expands', range.hour.join(','), '9,10,11,12,13,14,15,16,17');

  const rangeStep = parseCron('0 0-12/6 * * *');
  eq('0-12/6 expands', rangeStep.hour.join(','), '0,6,12');

  const list = parseCron('0 8,12,18 * * *');
  eq('list expands', list.hour.join(','), '8,12,18');

  const sunday7 = parseCron('0 9 * * 7');
  eq('7 normalizes to Sunday(0)', sunday7.dayOfWeek.join(','), '0');
}

console.log('\n[parse] rejects malformed input');
{
  const bad = [
    ['too few fields', '0 9 * *'],
    ['too many fields', '0 9 * * * *'],
    ['minute out of range', '60 9 * * *'],
    ['hour out of range', '0 24 * * *'],
    ['month out of range', '0 9 * 13 *'],
    ['inverted range', '0 17-9 * * *'],
    ['zero step', '*/0 * * * *'],
    ['garbage', 'not a cron'],
  ] as const;
  for (const [label, expr] of bad) {
    eq(`rejects ${label}`, validateCron(expr).ok, false);
  }
  eq('accepts valid', validateCron('30 6 * * 1-5').ok, true);
}

console.log('\n[match] basic matching in UTC');
{
  const f = parseCron('30 14 * * *');
  eq('matches 14:30', matches(f, utc(2026, 3, 10, 14, 30), 'UTC'), true);
  eq('rejects 14:31', matches(f, utc(2026, 3, 10, 14, 31), 'UTC'), false);
  eq('rejects 13:30', matches(f, utc(2026, 3, 10, 13, 30), 'UTC'), false);

  const midnight = parseCron('0 0 * * *');
  eq('matches midnight', matches(midnight, utc(2026, 3, 10, 0, 0), 'UTC'), true);
}

console.log('\n[match] POSIX day-of-month / day-of-week union');
{
  // 2026-03-13 is a Friday; 2026-03-15 is a Sunday.
  const both = parseCron('0 9 15 * 5');
  eq('dom matches (15th, not Friday)', matches(both, utc(2026, 3, 15, 9, 0), 'UTC'), true);
  eq('dow matches (Friday, not 15th)', matches(both, utc(2026, 3, 13, 9, 0), 'UTC'), true);
  eq('neither matches', matches(both, utc(2026, 3, 12, 9, 0), 'UTC'), false);

  // Only dom restricted → strict.
  const domOnly = parseCron('0 9 15 * *');
  eq('dom-only rejects other days', matches(domOnly, utc(2026, 3, 13, 9, 0), 'UTC'), false);
  eq('dom-only accepts the 15th', matches(domOnly, utc(2026, 3, 15, 9, 0), 'UTC'), true);
}

console.log('\n[match] timezone awareness');
{
  const f = parseCron('0 9 * * *');
  // 09:00 in Sofia (UTC+2 in winter) is 07:00 UTC.
  eq('09:00 Sofia == 07:00 UTC', matches(f, utc(2026, 1, 15, 7, 0), 'Europe/Sofia'), true);
  eq('09:00 UTC is not 09:00 Sofia', matches(f, utc(2026, 1, 15, 9, 0), 'Europe/Sofia'), false);
  // Same instant, evaluated in UTC, does match 09:00.
  eq('09:00 UTC matches in UTC', matches(f, utc(2026, 1, 15, 9, 0), 'UTC'), true);
}

console.log('\n[nextRun] finds the next occurrence');
{
  const from = utc(2026, 3, 10, 8, 0);
  const next = nextRun('0 9 * * *', from, 'UTC');
  check('daily 09:00 resolves', next !== null);
  eq('is same day 09:00', next?.toISOString(), utc(2026, 3, 10, 9, 0).toISOString());

  // Already past today's slot → rolls to tomorrow.
  const after = nextRun('0 9 * * *', utc(2026, 3, 10, 9, 30), 'UTC');
  eq('rolls to next day', after?.toISOString(), utc(2026, 3, 11, 9, 0).toISOString());

  // Strictly after `from`: an exact match must not return itself.
  const exact = nextRun('0 9 * * *', utc(2026, 3, 10, 9, 0), 'UTC');
  eq('strictly after from', exact?.toISOString(), utc(2026, 3, 11, 9, 0).toISOString());

  // Weekday-only: from Saturday should land on Monday.
  const weekday = nextRun('0 9 * * 1-5', utc(2026, 3, 14, 12, 0), 'UTC');
  eq('Saturday → Monday', weekday?.toISOString(), utc(2026, 3, 16, 9, 0).toISOString());

  // Every 15 minutes.
  const quarter = nextRun('*/15 * * * *', utc(2026, 3, 10, 8, 7), 'UTC');
  eq('*/15 → :15', quarter?.toISOString(), utc(2026, 3, 10, 8, 15).toISOString());

  // Feb 29 exists in 2028, not 2027.
  const leap = nextRun('0 12 29 2 *', utc(2026, 3, 1, 0, 0), 'UTC');
  eq('leap day resolves to 2028', leap?.getUTCFullYear(), 2028);
}

console.log('\n[nextRun] DST transitions do not hang or duplicate');
{
  // Europe/Sofia springs forward on 2026-03-29: local time jumps 02:59 → 04:00,
  // so **03:30 does not exist** that day (verified against Intl, not assumed).
  // A daily 03:30 routine must skip the 29th and fire on the 30th instead —
  // never hang, never fire at the wrong hour.
  // From 14:00 Sofia on the 28th the day's 03:30 has passed, so the next
  // candidate is the 29th — which has no 03:30 — and it must land on the 30th.
  const skipped = nextRun('30 3 * * *', utc(2026, 3, 28, 12, 0), 'Europe/Sofia');
  check('03:30 across spring-forward resolves', skipped !== null);
  eq('skips the nonexistent local hour, fires on the 30th', skipped?.getUTCDate(), 30);
  eq('and at the correct local time', skipped?.toISOString(), '2026-03-30T00:30:00.000Z');

  // Consecutive runs stay daily after the transition (no drift, no duplicate).
  const afterSkip = nextRun('30 3 * * *', skipped ?? new Date(), 'Europe/Sofia');
  eq('next occurrence is the 31st', afterSkip?.getUTCDate(), 31);

  // 02:30 DOES exist on the 29th (the jump is from 03:00), so it must fire.
  const exists = nextRun('30 2 * * *', utc(2026, 3, 28, 12, 0), 'Europe/Sofia');
  eq('02:30 still fires on the 29th', exists?.getUTCDate(), 29);

  // Autumn fall-back repeats an hour; a match must still be found exactly once.
  const repeated = nextRun('30 3 * * *', utc(2026, 10, 24, 12, 0), 'Europe/Sofia');
  check('03:30 across fall-back resolves', repeated !== null);
}

console.log('\n[describe] human-readable summaries');
{
  eq('daily', describeCron('0 9 * * *'), 'Every day at 09:00');
  eq('weekdays', describeCron('30 6 * * 1-5'), 'Weekdays at 06:30');
  eq('hourly', describeCron('15 * * * *'), 'Hourly at :15');
  eq('every minute', describeCron('* * * * *'), 'Every minute');
  eq('monthly', describeCron('0 8 1 * *'), 'Day 1 of each month at 08:00');
  // Unparseable input is echoed rather than throwing.
  eq('passthrough on garbage', describeCron('nonsense'), 'nonsense');
}

console.log('');
if (failures > 0) {
  console.error(`CRON TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('CRON TEST PASSED\n');
