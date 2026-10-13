// Expande reglas de recurrencia de Calendar (subconjunto de RRULE, RFC 5545).
// La automatización de Calendar devuelve solo el primer evento de cada serie,
// así que un seminario semanal creado hace meses no aparecería nunca. Es
// JavaScript plano que comparten la lectura JXA de respaldo (lib.rs) y su
// prueba de node; solo usa Intl y Date. Las repeticiones conservan la hora de
// pared de la serie en la zona configurada, también al cambiar la hora.

let recurrenceFormatter = null;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function configureRecurrenceZone(timeZone) {
  recurrenceFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
}

function zoneParts(date) {
  const parts = {};
  if (!recurrenceFormatter) configureRecurrenceZone("UTC");
  recurrenceFormatter.formatToParts(date).forEach((part) => { if (part.type !== "literal") parts[part.type] = Number(part.value); });
  return parts;
}

/** The instant at which the configured zone's wall clock shows the given civil time. */
function zoneInstant(year, month, day, hour, minute, second) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = wall;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const p = zoneParts(new Date(instant));
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const next = wall - (shown - instant);
    if (next === instant) break;
    instant = next;
  }
  return instant;
}

function parseRule(rule) {
  const out = {};
  String(rule || "").replace(/^RRULE:/i, "").split(";").forEach((pair) => {
    const [key, value] = pair.split("=");
    if (key && value) out[key.trim().toUpperCase()] = value.trim();
  });
  return out;
}

function parseUntil(value) {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value || "");
  if (!match) return null;
  const [, y, mo, d, h, mi, s, z] = match;
  if (h === undefined) return zoneInstant(+y, +mo, +d, 23, 59, 59);
  return z ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) : zoneInstant(+y, +mo, +d, +h, +mi, +s);
}

const civilDay = (year, month, day) => Math.floor(Date.UTC(year, month - 1, day) / 86400000);
const fromCivilDay = (index) => { const d = new Date(index * 86400000); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() }; };

/**
 * Occurrence starts (ms) of a series that overlap [rangeStart, rangeEnd).
 * `excluded` holds instants (ms) of deleted occurrences.
 * Unsupported rules return only the original start, as before.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- la llaman la lectura JXA y la prueba de node
function expandRecurrence(rule, startMs, endMs, rangeStart, rangeEnd, excluded, limit) {
  const r = parseRule(rule);
  const freq = r.FREQ;
  const duration = Math.max(0, endMs - startMs);
  const original = startMs < rangeEnd && startMs + duration > rangeStart ? [startMs] : [];
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return original;
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const until = r.UNTIL ? parseUntil(r.UNTIL) : null;
  const count = r.COUNT ? Math.max(1, Number(r.COUNT) || 1) : null;
  const base = zoneParts(new Date(startMs));
  const baseDay = civilDay(base.year, base.month, base.day);
  const baseWeekday = fromCivilDay(baseDay).weekday;
  const byDay = (r.BYDAY || "").split(",").filter(Boolean).map((token) => {
    const match = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token.toUpperCase());
    return match ? { nth: match[1] ? Number(match[1]) : 0, weekday: WEEKDAYS.indexOf(match[2]) } : null;
  }).filter(Boolean);
  const byMonthDay = (r.BYMONTHDAY || "").split(",").filter(Boolean).map(Number);
  const byMonth = (r.BYMONTH || "").split(",").filter(Boolean).map(Number);
  const excludedDays = new Set((excluded || []).map((ms) => { const p = zoneParts(new Date(ms)); return civilDay(p.year, p.month, p.day); }));
  // Weeks start on Monday (WKST default) for INTERVAL > 1 weekly rules.
  const mondayOf = (index) => index - ((fromCivilDay(index).weekday + 6) % 7);
  const lastDay = civilDay(...(() => { const p = zoneParts(new Date(rangeEnd)); return [p.year, p.month, p.day]; })());
  const matches = (index) => {
    const c = fromCivilDay(index);
    const months = (c.year - base.year) * 12 + (c.month - base.month);
    if (byMonth.length && !byMonth.includes(c.month)) return false;
    if (freq === "DAILY") return (index - baseDay) % interval === 0 && (!byDay.length || byDay.some((b) => b.weekday === c.weekday));
    if (freq === "WEEKLY") {
      if (((mondayOf(index) - mondayOf(baseDay)) / 7) % interval !== 0) return false;
      return byDay.length ? byDay.some((b) => b.weekday === c.weekday) : c.weekday === baseWeekday;
    }
    if (freq === "MONTHLY") {
      if (months % interval !== 0) return false;
      if (byMonthDay.length) {
        const length = new Date(Date.UTC(c.year, c.month, 0)).getUTCDate();
        return byMonthDay.some((d) => (d > 0 ? d : length + d + 1) === c.day);
      }
      if (byDay.length) {
        const length = new Date(Date.UTC(c.year, c.month, 0)).getUTCDate();
        return byDay.some((b) => b.weekday === c.weekday && (!b.nth || (b.nth > 0 ? Math.ceil(c.day / 7) === b.nth : Math.ceil((length - c.day + 1) / 7) === -b.nth)));
      }
      return c.day === base.day;
    }
    // YEARLY
    if ((c.year - base.year) % interval !== 0) return false;
    if (byMonth.length || byDay.length || byMonthDay.length) {
      if (!byMonth.length && c.month !== base.month) return false;
      if (byMonthDay.length) return byMonthDay.includes(c.day);
      if (byDay.length) return byDay.some((b) => b.weekday === c.weekday);
      return c.day === base.day;
    }
    return c.month === base.month && c.day === base.day;
  };
  const out = [];
  let seen = 0;
  for (let index = baseDay; index <= lastDay; index += 1) {
    if (!matches(index)) continue;
    const c = fromCivilDay(index);
    const occurrence = zoneInstant(c.year, c.month, c.day, base.hour, base.minute, base.second);
    if (occurrence < startMs) continue;
    if (until !== null && occurrence > until) break;
    seen += 1;
    if (count !== null && seen > count) break;
    if (excludedDays.has(index)) continue;
    if (occurrence < rangeEnd && occurrence + duration > rangeStart) out.push(occurrence);
    if (out.length >= (limit || 400)) break;
  }
  return out;
}
