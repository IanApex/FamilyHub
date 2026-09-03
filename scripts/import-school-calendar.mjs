#!/usr/bin/env node
// Import the Heritage Elementary school calendar into the FamilyHub calendar.
//
// The school site (Finalsite) renders one month per page at ?cal_date=YYYY-MM-DD,
// so this walks month by month and scrapes the event grid.
//
// Unlike meal slots, calendar events have no upsert endpoint, so this reads the
// existing events first and skips anything already imported. That makes it safe
// to re-run whenever the school posts more months.
//
// Usage:
//   node scripts/import-school-calendar.mjs [--dry-run] [--months 12] [--member "Name"]
//
// Credentials come from FAMILYHUB_USERNAME / FAMILYHUB_PASSWORD if set,
// otherwise you are prompted.

import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DRY_RUN = flag("dry-run");
const BASE = value("base", "http://127.0.0.1:8081").replace(/\/$/, "");
const MONTHS = Number(value("months", "12"));
const MEMBER_NAME = value("member", null);
const SCHOOL_URL = value("url", "https://heritage.deperek12.org/families/calendar");

// Marks imported events so they are easy to spot and clean up later.
const SOURCE_TAG = "Heritage Elementary school calendar";
// Names treated as the school pseudo-member, so imports skip the member prompt.
const SCHOOL_MEMBER_NAMES = ["heritage", "heritage elementary", "school"];
const TITLE_MAX = 100;
const ALL_DAY_START = "12:00 AM";
const ALL_DAY_END = "11:59 PM";

function ymd(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#8211;|&ndash;/g, "-")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// "2026-10-02T16:00:00-05:00" -> "4:00 PM". Read the clock fields straight from
// the string; the school's own offset is already baked in, and constructing a
// Date here would re-interpret it in the local zone.
function to12Hour(isoLocal) {
  const m = isoLocal.match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2];
  const meridian = hour >= 12 ? "PM" : "AM";
  hour = hour % 12 || 12;
  return `${hour}:${minute} ${meridian}`;
}

function parseMonth(html) {
  const events = [];
  // Each daybox holds one calendar square; squares for adjacent months are also
  // present, which is why callers dedupe across months.
  const boxes = html.split(/<div class="fsCalendarDaybox/).slice(1);

  for (const box of boxes) {
    const dateMatch = box.match(/<div class="fsCalendarDate"\s+data-day="(\d+)"\s+data-year="(\d+)"\s+data-month="(\d+)"/);
    if (!dateMatch) continue;

    const day = Number(dateMatch[1]);
    const year = Number(dateMatch[2]);
    const month = Number(dateMatch[3]) + 1; // Finalsite months are 0-based.
    const date = ymd(year, month, day);

    for (const block of box.split(/<div class="fsCalendarInfo"/).slice(1)) {
      const titleMatch = block.match(/class="fsCalendarEventTitle[^"]*"\s+title="([^"]*)"/);
      if (!titleMatch) continue;
      const title = decodeEntities(titleMatch[1]).slice(0, TITLE_MAX);
      if (!title) continue;

      const startMatch = block.match(/<time[^>]*datetime="([^"]+)"[^>]*class="fsStartTime"/);
      const endMatch = block.match(/<time[^>]*datetime="([^"]+)"[^>]*class="fsEndTime"/);

      const startTime = startMatch ? to12Hour(startMatch[1]) : null;
      const endTime = endMatch ? to12Hour(endMatch[1]) : null;

      if (startTime) {
        events.push({
          date,
          title,
          startTime,
          // A timed event without an end time gets a nominal one-hour block;
          // the API requires both and rejects end <= start.
          endTime: endTime && endTime !== startTime ? endTime : addHour(startTime),
          isAllDay: false,
        });
      } else {
        events.push({ date, title, startTime: ALL_DAY_START, endTime: ALL_DAY_END, isAllDay: true });
      }
    }
  }
  return events;
}

function addHour(time12) {
  const m = time12.match(/^(\d{1,2}):(\d{2}) (AM|PM)$/);
  if (!m) return time12;
  let hour = Number(m[1]) % 12 + (m[3] === "PM" ? 12 : 0);
  hour = (hour + 1) % 24;
  const meridian = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12}:${m[2]} ${meridian}`;
}

async function fetchMonth(year, month) {
  const url = `${SCHOOL_URL}?cal_date=${ymd(year, month, 1)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`School site returned HTTP ${res.status} for ${year}-${month}`);
  return parseMonth(await res.text());
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (str) => {
        if (str.includes(question)) rl.output.write(str);
      };
    }
    rl.question(question, (answer) => {
      if (hidden) rl.output.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const out = new Date(y, m - 1, d);
  out.setDate(out.getDate() + days);
  return ymd(out.getFullYear(), out.getMonth() + 1, out.getDate());
}

async function api(token, path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${options.method ?? "GET"} ${path} failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function login() {
  const username = process.env.FAMILYHUB_USERNAME || (await ask("FamilyHub username: "));
  const password = process.env.FAMILYHUB_PASSWORD || (await ask("FamilyHub password: ", { hidden: true }));
  const body = await api(null, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  const token = body?.data?.token;
  if (!token) throw new Error("Login succeeded but no token was returned.");
  return { token, familyName: body?.data?.family?.name ?? "(unknown)" };
}

async function resolveMember(token) {
  const members = (await api(token, "/api/family/members"))?.data ?? [];
  if (members.length === 0) {
    throw new Error("This family has no members yet. Add one in the app first.");
  }

  if (MEMBER_NAME) {
    const found = members.find((m) => m.name.toLowerCase() === MEMBER_NAME.toLowerCase());
    if (!found) {
      throw new Error(`No member named "${MEMBER_NAME}". Available: ${members.map((m) => m.name).join(", ")}`);
    }
    return found;
  }

  // A dedicated pseudo-member keeps closures and PTO meetings from looking like
  // one person's events, so prefer it when it exists.
  const school = members.find((m) => SCHOOL_MEMBER_NAMES.includes(m.name.toLowerCase()));
  if (school) return school;

  console.log("\nWhich family member should these school events belong to?");
  members.forEach((m, i) => console.log(`  ${i + 1}. ${m.name}`));
  const choice = Number(await ask("Number: "));
  const picked = members[choice - 1];
  if (!picked) throw new Error("Invalid selection.");
  return picked;
}

async function main() {
  const today = new Date();
  const startYear = today.getFullYear();
  const startMonth = today.getMonth() + 1;

  console.log(`Target:     ${BASE}`);
  console.log(`Source:     ${SCHOOL_URL}`);
  console.log(`Range:      ${MONTHS} months from ${ymd(startYear, startMonth, 1)}`);
  console.log(`Mode:       ${DRY_RUN ? "DRY RUN (nothing will be written)" : "live import"}\n`);

  // Scrape first so a dry run needs no credentials.
  const seen = new Set();
  const byMonth = [];
  const failures = [];

  for (let i = 0; i < MONTHS; i++) {
    const d = new Date(startYear, startMonth - 1 + i, 1);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    let events = [];
    try {
      events = await fetchMonth(year, month);
    } catch (err) {
      failures.push(err.message);
      continue;
    }

    // Adjacent-month squares repeat events, so keep the first sighting only.
    const fresh = [];
    for (const ev of events) {
      const key = `${ev.date}|${ev.title}|${ev.startTime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(ev);
    }
    byMonth.push({ label: `${year}-${String(month).padStart(2, "0")}`, events: fresh });
    await new Promise((r) => setTimeout(r, 150));
  }

  const all = byMonth.flatMap((m) => m.events).sort((a, b) => a.date.localeCompare(b.date));

  let token = null;
  let member = null;
  let existing = new Set();

  if (!DRY_RUN) {
    const session = await login();
    token = session.token;
    console.log(`Signed in as "${session.familyName}"`);
    member = await resolveMember(token);
    console.log(`Assigning events to ${member.name}\n`);

    // The events endpoint rejects ranges longer than a year, so page through
    // the scraped span in windows.
    let cursor = all.length ? all[0].date : null;
    const lastDate = all.length ? all[all.length - 1].date : null;
    while (cursor && cursor <= lastDate) {
      const windowEnd = addDays(cursor, 179) > lastDate ? lastDate : addDays(cursor, 179);
      const params = new URLSearchParams({ startDate: cursor, endDate: windowEnd });
      const page = (await api(token, `/api/calendar/events?${params}`))?.data ?? [];
      for (const ev of page) existing.add(`${ev.date}|${ev.title}`);
      cursor = addDays(windowEnd, 1);
    }
  }

  let created = 0;
  let skipped = 0;

  for (const { label, events } of byMonth) {
    if (!events.length) {
      console.log(`  ${label}  (no events published)`);
      continue;
    }
    console.log(`  ${label}`);
    for (const ev of events) {
      if (existing.has(`${ev.date}|${ev.title}`)) {
        skipped++;
        console.log(`    ${ev.date}  ${ev.title}  [already present]`);
        continue;
      }

      if (!DRY_RUN) {
        try {
          await api(token, "/api/calendar/events", {
            method: "POST",
            body: JSON.stringify({
              title: ev.title,
              startTime: ev.startTime,
              endTime: ev.endTime,
              date: ev.date,
              memberId: member.id,
              isAllDay: ev.isAllDay,
              description: SOURCE_TAG,
            }),
          });
        } catch (err) {
          failures.push(`${ev.date} "${ev.title}": ${err.message}`);
          continue;
        }
      }

      created++;
      const when = ev.isAllDay ? "all day" : `${ev.startTime} - ${ev.endTime}`;
      console.log(`    ${ev.date}  ${ev.title}  (${when})`);
    }
  }

  console.log(`\n${DRY_RUN ? "Would import" : "Imported"}: ${created} events`);
  if (skipped) console.log(`Skipped (already present): ${skipped}`);
  if (failures.length) {
    console.log(`\n${failures.length} problem(s):`);
    for (const f of failures.slice(0, 10)) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\nImport failed: ${err.message}`);
  process.exitCode = 1;
});
