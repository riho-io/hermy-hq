// Turns a raw Hermes cron schedule into short Estonian text and a group.
// Pure: no Date, no I/O. Unknown shapes fall back to the raw string, group "kuu" (Kuised/muud).

export type CronGroup = "valvur" | "paev" | "nadal" | "kuu";

export type ScheduleInfo = {
  text: string;
  group: CronGroup;
  // Approximate time between runs in minutes; null when the shape was not understood.
  intervalMin: number | null;
};

const DAY = 1440;
const WEEK = 7 * DAY;
const VALVUR_MAX_MIN = 6 * 60;

const WD = ["P", "E", "T", "K", "N", "R", "L", "P"]; // cron 0 and 7 = Sunday
const WD_NAMES: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const MONTH_ON = [
  "jaanuaril", "veebruaril", "märtsil", "aprillil", "mail", "juunil",
  "juulil", "augustil", "septembril", "oktoobril", "novembril", "detsembril",
];

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (h: number, m: number) => `${pad(h)}:${pad(m)}`;
const isNum = (s: string) => /^\d+$/.test(s);
const joinEt = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ja ${xs[xs.length - 1]}`);

function groupFor(intervalMin: number): CronGroup {
  if (intervalMin <= VALVUR_MAX_MIN) return "valvur";
  if (intervalMin <= DAY) return "paev";
  if (intervalMin <= WEEK) return "nadal";
  return "kuu";
}

function everyMinutes(n: number): string {
  if (n % DAY === 0) return n === DAY ? "iga päev" : `iga ${n / DAY} päeva`;
  if (n % 60 === 0) return `iga ${n / 60} h`;
  return `iga ${n} min`;
}

// "every 360m", "every 2h", "every 1d"
function parseEvery(s: string): ScheduleInfo | null {
  const m = /^every\s+(\d+)\s*(m|min|h|d)$/.exec(s);
  if (!m) return null;
  const mult = m[2] === "h" ? 60 : m[2] === "d" ? DAY : 1;
  const n = Number(m[1]) * mult;
  if (n <= 0) return null;
  return { text: everyMinutes(n), group: groupFor(n), intervalMin: n };
}

// "every monday 10:00am"
function parseEveryWeekday(s: string): ScheduleInfo | null {
  const m = /^every\s+([a-z]+)\s+(\d{1,2}):(\d{2})\s*(am|pm)?$/.exec(s);
  if (!m || !(m[1] in WD_NAMES)) return null;
  let h = Number(m[2]);
  const min = Number(m[3]);
  if (m[4] === "pm" && h < 12) h += 12;
  if (m[4] === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { text: `${WD[WD_NAMES[m[1]]]} ${hhmm(h, min)}`, group: "nadal", intervalMin: WEEK };
}

type TimePart =
  | { kind: "freq"; text: string; perHour: number; hours: number } // runs several times
  | { kind: "fixed"; times: string[] }; // runs at clock times

function range(s: string, max: number): [number, number] | null {
  const m = /^(\d+)-(\d+)$/.exec(s);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a <= b && b <= max ? [a, b] : null;
}

function list(s: string, max: number): number[] | null {
  const parts = s.split(",");
  if (!parts.every(isNum)) return null;
  const xs = parts.map(Number);
  return xs.every((x) => x <= max) ? xs : null;
}

function step(s: string): number | null {
  if (s === "*") return 1;
  const m = /^\*\/(\d+)$/.exec(s);
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

function timePart(min: string, hour: string): TimePart | null {
  const minStep = step(min);
  const minList = list(min, 59);
  const hourRange = range(hour, 23);
  const hourStep = step(hour);
  const hourList = list(hour, 23);
  const span = hourRange ? `, ${hourRange[0]}–${hourRange[1]}` : "";
  const hours = hourRange ? hourRange[1] - hourRange[0] + 1 : 24;

  if (minStep && (hour === "*" || hourRange)) {
    return { kind: "freq", text: `${everyMinutes(minStep)}${span}`, perHour: 60 / minStep, hours };
  }
  if (minList && (hour === "*" || hourRange)) {
    const marks = minList.map((x) => `:${pad(x)}`);
    const text = hour === "*" && minList.length === 1 ? `iga tund ${marks[0]}` : `${joinEt(marks)}${span}`;
    return { kind: "freq", text, perHour: minList.length, hours };
  }
  if (minList && minList.length === 1 && hourStep && hour !== "*") {
    const off = minList[0] === 0 ? "" : ` (:${pad(minList[0])})`;
    return { kind: "freq", text: `${everyMinutes(hourStep * 60)}${off}`, perHour: 1 / hourStep, hours: 24 };
  }
  if (minList && minList.length === 1 && hourList) {
    return { kind: "fixed", times: hourList.map((h) => hhmm(h, minList[0])) };
  }
  return null;
}

function dowLabel(dow: string): { text: string; days: number } | null {
  if (dow === "1-5") return { text: "E–R", days: 5 };
  const r = range(dow, 7);
  if (r) return { text: `${WD[r[0]]}–${WD[r[1]]}`, days: r[1] - r[0] + 1 };
  const xs = list(dow, 7);
  if (!xs) return null;
  return { text: xs.map((d) => WD[d]).join(", "), days: new Set(xs.map((d) => d % 7)).size };
}

function parseCron(s: string): ScheduleInfo | null {
  const f = s.split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f;
  const t = timePart(min, hour);
  if (!t) return null;

  const runsPerDay = t.kind === "freq" ? t.perHour * t.hours : t.times.length;
  const dayInterval = DAY / runsPerDay;
  // Frequent jobs: "iga 30 min, 7–21" (+ weekdays when restricted)
  if (t.kind === "freq") {
    if (dom !== "*" || mon !== "*") return null;
    if (dow === "*") return { text: t.text, group: groupFor(dayInterval), intervalMin: dayInterval };
    const d = dowLabel(dow);
    if (!d) return null;
    return { text: `${t.text}, ${d.text}`, group: groupFor(dayInterval), intervalMin: dayInterval };
  }

  const times = joinEt(t.times);
  if (dom === "*" && mon === "*") {
    if (dow === "*") return { text: `iga päev ${times}`, group: "paev", intervalMin: dayInterval };
    const d = dowLabel(dow);
    if (!d) return null;
    // Weekdays (E–R) behave like daily jobs; fewer days per week are weekly.
    const group: CronGroup = d.days >= 5 ? "paev" : "nadal";
    return { text: `${d.text} ${times}`, group, intervalMin: (WEEK / d.days) / t.times.length };
  }
  if (isNum(dom) && Number(dom) >= 1 && Number(dom) <= 31 && dow === "*") {
    if (mon === "*") return { text: `${dom}. kuupäeval ${times}`, group: "kuu", intervalMin: 30 * DAY };
    if (isNum(mon) && Number(mon) >= 1 && Number(mon) <= 12) {
      return { text: `${dom}. ${MONTH_ON[Number(mon) - 1]} ${times}`, group: "kuu", intervalMin: 365 * DAY };
    }
  }
  return null;
}

export function describeSchedule(raw: string): ScheduleInfo {
  const s = (raw || "").trim().toLowerCase().replace(/\s+/g, " ");
  return parseEvery(s) ?? parseEveryWeekday(s) ?? parseCron(s) ?? { text: raw, group: "kuu", intervalMin: null };
}

export const humanSchedule = (raw: string) => describeSchedule(raw).text;
export const scheduleGroup = (raw: string) => describeSchedule(raw).group;
