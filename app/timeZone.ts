/**
 * Utilidades de fecha para la zona horaria configurada (`time_zone` en la
 * configuración de Esprit). Los textos siguen en `es-ES`; solo cambia la zona.
 */

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const partFormatters = new Map<string, Intl.DateTimeFormat>();

const partFormatter = (timeZone: string) => {
  let formatter = partFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    partFormatters.set(timeZone, formatter);
  }
  return formatter;
};

export const isValidTimeZone = (timeZone: string) => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
};

export const zonedParts = (date: Date, timeZone: string): ZonedParts => {
  const values = Object.fromEntries(partFormatter(timeZone).formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
  return values as ZonedParts;
};

export const dateKeyFromParts = ({ year, month, day }: Pick<ZonedParts, 'year' | 'month' | 'day'>) => (
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
);

/** Día `YYYY-MM-DD` de un instante en la zona indicada. */
export const zonedDateKey = (date: Date, timeZone: string) => dateKeyFromParts(zonedParts(date, timeZone));

/** Día siguiente a una fecha abstracta `YYYY-MM-DD`. */
export const nextDateKey = (date: string) => {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
};

/**
 * Convierte una hora de reloj de la zona configurada en un instante ISO con
 * desplazamiento explícito. Rechaza las horas que no existen por el cambio
 * horario en lugar de moverlas en silencio.
 */
export const zonedWallTimeIso = (date: string, time: string, timeZone: string) => {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) throw new Error('La fecha u hora no es válida.');

  const wallTime = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = wallTime;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = zonedParts(new Date(instant), timeZone);
    const representedWallTime = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const next = wallTime - (representedWallTime - instant);
    if (next === instant) break;
    instant = next;
  }

  const resolved = zonedParts(new Date(instant), timeZone);
  if (resolved.year !== year || resolved.month !== month || resolved.day !== day || resolved.hour !== hour || resolved.minute !== minute) {
    throw new Error(`Esa hora no existe en ${timeZone} por el cambio horario. Elige otra hora.`);
  }
  const offsetMinutes = Math.round((wallTime - instant) / 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${date}T${pad(hour)}:${pad(minute)}:00${sign}${pad(Math.trunc(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
};
