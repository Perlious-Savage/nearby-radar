// Tolerant parser for the real OSM opening_hours strings in our data.
// Split out from app.js so tools/test-hours.mjs can exercise it in node.
// Tolerant parser for the real OSM opening_hours strings in our data. It
// deliberately returns null when it cannot parse rather than guessing, so the
// UI can say "hours unknown" instead of inventing a time.
const DAYS = { mo: 0, tu: 1, we: 2, th: 3, fr: 4, sa: 5, su: 6 };

export function parseHours(spec) {
  if (!spec) return null;
  const s = spec.toLowerCase().replace(/\bmon|tue|wed|thu|fri|sat|sun/g, m => m.slice(0, 2))
    .replace(/[:]\s(?=\d)/g, ' ').replace(/\s+/g, ' ').trim();
  if (s === '24/7') return [{ days: [0, 1, 2, 3, 4, 5, 6], from: 0, to: 1440 }];

  // A comma separates time spans within a rule ("12:00-15:00,17:00-22:00") but
  // OSM also uses it between whole rules ("Fr-We 18:00-02:00, Th 18:00-03:00").
  // Only the second kind follows a time and precedes a day name; promote just
  // those to rule separators, or the trailing rule is silently dropped.
  // The lookbehind is what keeps "Mo-Su,PH 09:00-12:00" in one piece.
  const ruled = s.replace(/(?<=\d)\s*,\s*(?=(?:mo|tu|we|th|fr|sa|su)\b)/g, ';');

  const rules = [];
  for (const chunk of ruled.split(';')) {
    const part = chunk.trim();
    if (!part) continue;

    const dayMatch = part.match(/^((?:mo|tu|we|th|fr|sa|su|ph)(?:\s*-\s*(?:mo|tu|we|th|fr|sa|su))?(?:\s*,\s*(?:mo|tu|we|th|fr|sa|su|ph)(?:\s*-\s*(?:mo|tu|we|th|fr|sa|su))?)*)\s+/);
    let days = [0, 1, 2, 3, 4, 5, 6];
    let rest = part;
    if (dayMatch) {
      days = [];
      for (const tok of dayMatch[1].split(',')) {
        const [a, b] = tok.trim().split('-').map(x => x.trim());
        if (a === 'ph') continue;              // public holidays: ignore
        if (DAYS[a] == null) continue;
        if (b == null) { days.push(DAYS[a]); continue; }
        for (let d = DAYS[a]; ; d = (d + 1) % 7) {
          days.push(d);
          if (d === DAYS[b]) break;
        }
      }
      rest = part.slice(dayMatch[0].length);
      if (!days.length) days = [0, 1, 2, 3, 4, 5, 6];
    }

    for (const span of rest.split(',')) {
      const m = span.trim().match(/^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/);
      if (m) {
        rules.push({ days, from: +m[1] * 60 + +m[2], to: +m[3] * 60 + +m[4] });
        continue;
      }
      const open = span.trim().match(/^(\d{1,2}):(\d{2})\s*\+$/);   // e.g. "19:00+"
      if (open) rules.push({ days, from: +open[1] * 60 + +open[2], to: 1440 });
    }
  }
  return rules.length ? rules : null;
}

// Returns {open, closesIn} in minutes, or null when the hours are unknown.
export function openState(spec, now = new Date()) {
  const rules = parseHours(spec);
  if (!rules) return null;
  const today = (now.getDay() + 6) % 7;
  const yesterday = (today + 6) % 7;
  const mins = now.getHours() * 60 + now.getMinutes();

  for (const r of rules) {
    const overnight = r.to <= r.from;
    if (!overnight && r.days.includes(today) && mins >= r.from && mins < r.to) {
      return { open: true, closesIn: r.to - mins };
    }
    if (overnight) {
      if (r.days.includes(today) && mins >= r.from) return { open: true, closesIn: 1440 - mins + r.to };
      if (r.days.includes(yesterday) && mins < r.to) return { open: true, closesIn: r.to - mins };
    }
  }
  return { open: false, closesIn: null };
}

