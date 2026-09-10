// The only non-trivial pure logic in the app: deciding whether a real place is
// open right now. "Open now" drives the ranking the whole brief hangs on, so a
// silent bug here is the expensive kind.
//
//   node tools/test-hours.mjs
//
// Every string below is a verbatim opening_hours value from data/jbr.json.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openState, parseHours } from '../js/hours.js';

// Monday 2026-09-07 at 14:30 local, and a few other probes.
const monAfternoon = new Date(2026, 8, 7, 14, 30);
const monLateNight = new Date(2026, 8, 7, 2, 15);
const satNoon = new Date(2026, 8, 12, 12, 30);

let checks = 0;
const is = (spec, when, expected, why) => {
  const got = openState(spec, when);
  assert.deepEqual(got === null ? null : got.open, expected, `${why}: ${spec}`);
  checks++;
};

// Always open.
is('24/7', monAfternoon, true, '24/7 afternoon');
is('24/7', monLateNight, true, '24/7 at 2am');

// Plain daily range, no day prefix.
is('07:00-23:00', monAfternoon, true, 'daily range, inside');
is('07:30-19:30', monLateNight, false, 'daily range, outside');

// Day-scoped ranges.
is('Mo-Su 09:00-24:00', monAfternoon, true, 'Mo-Su covers Monday');
is('Mo-Su 11:00-22:30', monLateNight, false, 'closed at 2am');
is('Mon-Fri 12:30 - 23:00; Sat-Sun 12:30-16:00', satNoon, true, 'weekend rule picked');

// Overnight spans: the close time is the NEXT day, which is where a naive
// start<=now<end comparison silently fails.
is('Mo-Su 10:00-03:00', monLateNight, true, 'overnight, still open at 2:15am');
is('Mo-Su 12:00-01:00', monAfternoon, true, 'overnight rule, afternoon inside');
is('Fr-We 18:00-02:00, Th 18:00-03:00', monAfternoon, false, 'evening bar shut at 14:30');
// Sunday night's 18:00-02:00 rule ends at 2am, so 2:15am Monday is shut.
is('Fr-We 18:00-02:00, Th 18:00-03:00', monLateNight, false, 'closed 15 min after last call');

// Here the comma separates two RULES, not two time spans. Splitting it the
// wrong way drops the Thursday rule and nobody notices until a Thursday.
is('Fr-We 18:00-02:00, Th 18:00-03:00', new Date(2026, 8, 10, 20, 0), true, 'Thu rule survives the comma');
is('Fr-We 18:00-02:00, Th 18:00-03:00', new Date(2026, 8, 11, 2, 30), true, 'Thu runs to 3am, into Friday');
is('Fr-We 18:00-02:00, Th 18:00-03:00', new Date(2026, 8, 11, 2, 30 + 45), false, 'and stops there');

// Wrapping day ranges: Fr-We means Fr,Sa,Su,Mo,Tu,We.
const fr = parseHours('Fr-We 18:00-02:00')[0].days;
assert.deepEqual([...fr].sort((a, b) => a - b), [0, 1, 2, 4, 5, 6], 'Fr-We wraps past Sunday');
assert.ok(!fr.includes(3), 'Fr-We excludes Thursday');
checks += 2;

// Split services in one day.
is('Mo-Su 12:00-15:00,17:00-22:00', monAfternoon, true, 'inside the lunch service');
is('Mo-Su 12:00-15:00,17:00-22:00', new Date(2026, 8, 7, 16, 0), false, 'in the afternoon gap');

// Open-ended and public-holiday tokens must not throw or swallow the rule.
is('19:00+', new Date(2026, 8, 7, 20, 0), true, 'open-ended evening');
is('Mo-Su,PH 09:00-12:00', new Date(2026, 8, 7, 10, 0), true, 'PH token ignored, not fatal');

// Unknown hours must be null, never a guess. This is what lets the UI say
// "hours unknown" instead of inventing a time.
assert.equal(openState(null), null, 'missing hours are unknown');
assert.equal(openState(''), null, 'empty hours are unknown');
assert.equal(openState('by appointment'), null, 'unparseable prose is unknown');
checks += 3;

// Nothing in the shipped data may crash the parser.
const data = JSON.parse(await readFile(new URL('../data/jbr.json', import.meta.url), 'utf8'));
let parsed = 0;
for (const s of data.spots) {
  const st = openState(s.hours);
  assert.ok(st === null || typeof st.open === 'boolean', `bad result for ${s.name}`);
  if (s.hours && st === null) throw new Error(`unparsed real value on ${s.name}: ${s.hours}`);
  if (st) parsed++;
}

console.log(`${checks} assertions passed`);
console.log(`${parsed}/${data.spots.length} shipped places have hours the parser understands`);
