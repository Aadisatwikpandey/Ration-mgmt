// Reminder schedule helpers, shared by the browser (Google Calendar links) and server (.ics).

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const RRULE_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

const pad = (n) => String(n).padStart(2, "0");

function atTime(date, time) {
  const [h, m] = String(time || "10:00").split(":").map(Number);
  const d = new Date(date);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

export function nextMonthly(day, time, now = new Date()) {
  let d = atTime(new Date(now.getFullYear(), now.getMonth(), day), time);
  if (d < now) d = atTime(new Date(now.getFullYear(), now.getMonth() + 1, day), time);
  return d;
}

export function nextWeekly(weekday, time, now = new Date()) {
  const d = atTime(now, time);
  d.setDate(d.getDate() + ((weekday - d.getDay() + 7) % 7));
  if (d < now) d.setDate(d.getDate() + 7);
  return d;
}

// Floating local time (no timezone suffix) so the calendar uses the phone's own time zone.
export function icsDate(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
}

export function reminderEvents(settings) {
  const time = settings.reminderTime || "10:00";
  const monthlyDay = Number(settings.monthlyDay) || 1;
  const weeklyDay = Number(settings.weeklyDay) || 0;
  return [
    {
      uid: "ration-monthly@ration-app",
      title: "🧺 Monthly wholesale ration shopping",
      start: nextMonthly(monthlyDay, time),
      rrule: `FREQ=MONTHLY;BYMONTHDAY=${monthlyDay}`,
      alarms: ["-P1D", "PT0M"],
    },
    {
      uid: "ration-weekly@ration-app",
      title: "🥬 Weekly veg, milk & fresh shopping",
      start: nextWeekly(weeklyDay, time),
      rrule: `FREQ=WEEKLY;BYDAY=${RRULE_DAYS[weeklyDay]}`,
      alarms: ["PT0M"],
    },
  ];
}
