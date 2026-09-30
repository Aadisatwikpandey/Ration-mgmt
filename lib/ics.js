// Builds a .ics file with the repeating monthly and weekly shopping reminders.
import { icsDate, reminderEvents } from "../public/shared/schedule.js";

const esc = (s) => String(s).replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");

export function buildIcs(settings, appUrl) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ration-app//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const ev of reminderEvents(settings)) {
    const end = new Date(ev.start.getTime() + 60 * 60 * 1000);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${ev.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(ev.start)}`,
      `DTEND:${icsDate(end)}`,
      `RRULE:${ev.rrule}`,
      `SUMMARY:${esc(ev.title)}`,
      `DESCRIPTION:${esc(`Open your list: ${appUrl}`)}`,
    );
    for (const trigger of ev.alarms) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(ev.title)}`, `TRIGGER:${trigger}`, "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
