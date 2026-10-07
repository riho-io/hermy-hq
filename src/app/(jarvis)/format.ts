// Server renders in UTC on Vercel; every time on /jarvis is shown in Tallinn time.
const TZ = 'Europe/Tallinn';

const timeFmt = new Intl.DateTimeFormat('et-EE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('et-EE', { timeZone: TZ, day: 'numeric', month: 'numeric' });
const headFmt = new Intl.DateTimeFormat('et-EE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

export const fmtTime = (d: Date) => timeFmt.format(d);
export const fmtHeading = (d: Date) => headFmt.format(d);

/** "17:41" today, "26.9 13:58" otherwise. */
export function fmtWhen(d: Date, now: Date): string {
  return dayKey.format(d) === dayKey.format(now) ? fmtTime(d) : `${dateFmt.format(d)} ${fmtTime(d)}`;
}

/** "just nüüd", "12 min tagasi", "3 h tagasi", "10 p tagasi". */
export function fmtAgo(d: Date, now: Date): string {
  const min = Math.round((now.getTime() - d.getTime()) / 60_000);
  if (min < 1) return 'just nüüd';
  if (min < 60) return `${min} min tagasi`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h tagasi`;
  return `${Math.round(h / 24)} p tagasi`;
}

/** Hour-of-day in Tallinn for axis labels. */
export function tallinnHour(d: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(d));
}
