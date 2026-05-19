/**
 * Tiny iCalendar (RFC 5545) builder. We hand-roll the format instead of pulling
 * a dependency because the surface we need is small:
 *   - one VCALENDAR
 *   - N VEVENTs (one per lesson occurrence)
 *   - UTC timestamps (avoids VTIMEZONE)
 *
 * Returned as a UTF-8 string. Caller is responsible for base64-encoding it
 * when handing to Resend (Resend's `attachments` accepts a base64 string).
 */

export type IcsEvent = {
  /** Stable identifier (e.g. ScheduledEvent.id) — drives UID. */
  id: string;
  startTime: Date;
  endTime: Date;
  summary: string;       // Event title shown in the calendar
  description?: string;
  location?: string;
};

export type IcsCalendarParams = {
  prodId: string;        // e.g. "-//Art & Cetera//Reservation//FR"
  calendarName: string;  // e.g. "Cours de violon — Trimestre 2026 T2"
  events: IcsEvent[];
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Format a Date as a UTC iCalendar timestamp: YYYYMMDDTHHMMSSZ. */
function formatIcsUtc(d: Date): string {
  return (
    d.getUTCFullYear().toString() +
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate()) +
    'T' +
    pad2(d.getUTCHours()) +
    pad2(d.getUTCMinutes()) +
    pad2(d.getUTCSeconds()) +
    'Z'
  );
}

/**
 * Escape a text field per RFC 5545 §3.3.11 — commas, semicolons and newlines
 * carry meaning in the property syntax.
 */
function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/**
 * Fold long lines at 75 octets per RFC 5545 §3.1. CRLF + a leading space on
 * continuation lines. Some clients are forgiving but Outlook and certain
 * Apple Mail versions reject unfolded long lines.
 */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const chunk = line.slice(i, i === 0 ? 75 : i + 74);
    out.push(chunk);
    i += chunk.length;
  }
  return out.join('\r\n ');
}

/** Build the full VCALENDAR string. */
export function buildIcsCalendar(params: IcsCalendarParams): string {
  const now = formatIcsUtc(new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${params.prodId}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(params.calendarName)}`,
  ];

  for (const ev of params.events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${ev.id}@artcetera`);
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART:${formatIcsUtc(ev.startTime)}`);
    lines.push(`DTEND:${formatIcsUtc(ev.endTime)}`);
    lines.push(`SUMMARY:${escapeIcsText(ev.summary)}`);
    if (ev.description) {
      lines.push(`DESCRIPTION:${escapeIcsText(ev.description)}`);
    }
    if (ev.location) {
      lines.push(`LOCATION:${escapeIcsText(ev.location)}`);
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  // Fold + CRLF terminate per spec.
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
