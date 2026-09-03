#!/usr/bin/env node
// Move already-imported school calendar events onto a dedicated "School" member.
//
// Calendar events require a member, so school closures and PTO meetings would
// otherwise sit under a real person. A pseudo-member keeps them visually
// separate and leaves everyone's own filter view clean.
//
// Only events carrying the importer's description tag are touched, so anything
// entered by hand is left alone. Safe to re-run.
//
// Usage:
//   node scripts/reassign-school-events.mjs [--dry-run] [--name School]

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
const MEMBER_NAME = value("name", "School");
const FROM = value("from", "2026-08-01");
const TO = value("to", "2027-08-31");

// Must match the tag written by import-school-calendar.mjs.
const SOURCE_TAG = "Heritage Elementary school calendar";
const COLORS = ["TEAL", "PURPLE", "ORANGE", "GREEN", "PINK", "YELLOW", "CORAL"];

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

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const out = new Date(y, m - 1, d);
  out.setDate(out.getDate() + days);
  return ymd(out);
}

// The events endpoint rejects any range longer than a year, so walk the range
// in windows and stitch the results together.
async function fetchEvents(token, from, to, windowDays = 180) {
  const byId = new Map();
  let cursor = from;
  while (cursor <= to) {
    const windowEnd = addDays(cursor, windowDays - 1) > to ? to : addDays(cursor, windowDays - 1);
    const params = new URLSearchParams({ startDate: cursor, endDate: windowEnd });
    const page = (await api(token, `/api/calendar/events?${params}`))?.data ?? [];
    for (const ev of page) byId.set(ev.id ?? `${ev.date}|${ev.title}`, ev);
    cursor = addDays(windowEnd, 1);
  }
  return [...byId.values()];
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
  return token;
}

async function ensureMember(token, members) {
  const existing = members.find((m) => m.name.toLowerCase() === MEMBER_NAME.toLowerCase());
  if (existing) {
    console.log(`Using existing member "${existing.name}" (${existing.color})`);
    return existing;
  }

  // Pick a color nobody else is using so school events stand out.
  const taken = new Set(members.map((m) => m.color));
  const color = COLORS.find((c) => !taken.has(c)) ?? COLORS[0];

  if (DRY_RUN) {
    console.log(`Would create member "${MEMBER_NAME}" with color ${color}`);
    return { id: "(dry-run)", name: MEMBER_NAME, color };
  }

  const created = (
    await api(token, "/api/family/members", {
      method: "POST",
      body: JSON.stringify({ name: MEMBER_NAME, color }),
    })
  )?.data;
  console.log(`Created member "${created.name}" with color ${created.color}`);
  return created;
}

async function main() {
  console.log(`Target: ${BASE}`);
  console.log(`Mode:   ${DRY_RUN ? "DRY RUN (nothing will be written)" : "live update"}\n`);

  const token = await login();
  const members = (await api(token, "/api/family/members"))?.data ?? [];
  const school = await ensureMember(token, members);

  const events = await fetchEvents(token, FROM, TO);

  const targets = events.filter(
    (e) => e.description === SOURCE_TAG && e.memberId !== school.id && !e.recurringEventId,
  );

  if (targets.length === 0) {
    console.log(`\nNothing to move. Found ${events.length} events in range, none tagged as school imports.`);
    return;
  }

  console.log(`\nMoving ${targets.length} school events to "${school.name}":`);
  let moved = 0;
  const failures = [];

  for (const ev of targets) {
    if (!DRY_RUN) {
      try {
        await api(token, `/api/calendar/events/${ev.id}`, {
          method: "PUT",
          body: JSON.stringify({
            title: ev.title,
            startTime: ev.startTime,
            endTime: ev.endTime,
            date: ev.date,
            memberId: school.id,
            isAllDay: ev.isAllDay,
            location: ev.location,
            endDate: ev.endDate,
            recurrenceRule: ev.recurrenceRule,
            description: ev.description,
          }),
        });
      } catch (err) {
        failures.push(`${ev.date} "${ev.title}": ${err.message}`);
        continue;
      }
    }
    moved++;
    console.log(`  ${ev.date}  ${ev.title}`);
  }

  console.log(`\n${DRY_RUN ? "Would move" : "Moved"}: ${moved} events`);
  if (failures.length) {
    console.log(`\n${failures.length} problem(s):`);
    for (const f of failures.slice(0, 10)) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exitCode = 1;
});
