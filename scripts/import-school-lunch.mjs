#!/usr/bin/env node
// Import school lunch menus from Nutrislice into the FamilyHub meal board.
//
// Nutrislice publishes roughly a month ahead, so this is meant to be re-run as
// new weeks appear. Re-importing a week overwrites it rather than duplicating.
//
// Usage:
//   node scripts/import-school-lunch.mjs [--dry-run] [--base URL] [--weeks N]
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
const WEEKS = Number(value("weeks", "16"));

const NUTRISLICE = {
  host: value("district", "deperek12"),
  school: value("school", "heritage-elementary"),
  menuType: value("menu-type", "lunch"),
};

// These appear on every single day and only add noise to the board.
const SKIP_ITEMS = ["milk choice", "fresh veggie selections"];

// Gluten-free alternates. The district names them three different ways:
// "GF Chicken Strips", "Hamburger on GF Bun", and "Gluten-Free Snack".
const SKIP_PATTERNS = [/\bgf\b/i, /gluten[-\s]?free/i];

const MEAL_TYPE = "lunch";
const TITLE_MAX = 160;

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nutrislicePath(d) {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

// Parse "2026-09-01" as local midnight. Never use new Date(string) here: it
// parses as UTC and lands on the previous day west of Greenwich.
function parseLocal(s) {
  const [y, m, day] = s.split("-").map(Number);
  return new Date(y, m - 1, day);
}

function mostRecentSunday(d) {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() - out.getDay());
  return out;
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    if (hidden) {
      // Suppress echo so the password is not shown or left in scrollback.
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

async function login() {
  const username = process.env.FAMILYHUB_USERNAME || (await ask("FamilyHub username: "));
  const password = process.env.FAMILYHUB_PASSWORD || (await ask("FamilyHub password: ", { hidden: true }));

  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    throw new Error(`Login failed (HTTP ${res.status}). Check the username and password.`);
  }
  const body = await res.json();
  const token = body?.data?.token;
  if (!token) throw new Error("Login succeeded but no token was returned.");
  return { token, familyName: body?.data?.family?.name ?? "(unknown)" };
}

async function fetchWeek(sunday) {
  const url = `https://${NUTRISLICE.host}.api.nutrislice.com/menu/api/weeks/school/${NUTRISLICE.school}/menu-type/${NUTRISLICE.menuType}/${nutrislicePath(sunday)}/`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Nutrislice returned HTTP ${res.status} for ${ymd(sunday)}`);
  return res.json();
}

// Split a day's menu into one primary entry plus extras. Entrees win the
// primary spot; any additional entrees fall back to extras.
function buildEntries(menuItems) {
  const foods = menuItems
    .filter((i) => i.food?.name)
    .map((i) => ({ name: i.food.name.trim(), category: (i.food.food_category ?? "").toLowerCase() }))
    .filter((f) => !SKIP_ITEMS.includes(f.name.toLowerCase()))
    .filter((f) => !SKIP_PATTERNS.some((p) => p.test(f.name)))
    .filter((f) => f.name.length <= TITLE_MAX);

  if (foods.length === 0) return null;

  const entreeIndex = foods.findIndex((f) => f.category === "entree");
  const primaryIndex = entreeIndex >= 0 ? entreeIndex : 0;
  const primary = foods[primaryIndex];
  const extras = foods.filter((_, idx) => idx !== primaryIndex);

  return {
    primary: { sourceType: "quick", title: primary.name },
    extras: extras.map((f) => ({ sourceType: "quick", title: f.name })),
  };
}

async function upsertSlot(token, weekStartDate, dayIndex, entries) {
  const res = await fetch(`${BASE}/api/meals/slots`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      weekStartDate,
      dayIndex,
      mealType: MEAL_TYPE,
      primary: entries.primary,
      extras: entries.extras,
      // Overwrite on re-run so newly published or corrected menus replace the
      // old import instead of stacking up as extras.
      collisionMode: "replace_primary",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Slot ${weekStartDate} day ${dayIndex} failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function main() {
  console.log(`Target:     ${BASE}`);
  console.log(`Menu:       ${NUTRISLICE.school} / ${NUTRISLICE.menuType}`);
  console.log(`Mode:       ${DRY_RUN ? "DRY RUN (nothing will be written)" : "live import"}\n`);

  let token = null;
  let familyName = null;
  if (!DRY_RUN) {
    ({ token, familyName } = await login());
    console.log(`Signed in as "${familyName}"\n`);
  }

  let weeksWithData = 0;
  let slotsWritten = 0;
  let itemsWritten = 0;
  const failures = [];

  const firstSunday = mostRecentSunday(new Date());

  for (let w = 0; w < WEEKS; w++) {
    const sunday = new Date(firstSunday);
    sunday.setDate(sunday.getDate() + w * 7);
    const weekStartDate = ymd(sunday);

    let week;
    try {
      week = await fetchWeek(sunday);
    } catch (err) {
      failures.push(`${weekStartDate}: ${err.message}`);
      continue;
    }

    const dayLines = [];
    for (const day of week.days ?? []) {
      const entries = buildEntries(day.menu_items ?? []);
      if (!entries) continue;

      const date = parseLocal(day.date);
      const dayIndex = Math.round((date - sunday) / 86400000);
      if (dayIndex < 0 || dayIndex > 6) continue;

      if (!DRY_RUN) {
        try {
          await upsertSlot(token, weekStartDate, dayIndex, entries);
        } catch (err) {
          failures.push(err.message);
          continue;
        }
      }

      slotsWritten++;
      itemsWritten += 1 + entries.extras.length;
      dayLines.push(
        `    ${DAY_NAMES[dayIndex]} ${day.date}  ${entries.primary.title}` +
          (entries.extras.length ? `  (+${entries.extras.length}: ${entries.extras.map((e) => e.title).join(", ")})` : ""),
      );
    }

    if (dayLines.length) {
      weeksWithData++;
      console.log(`  Week of ${weekStartDate}`);
      console.log(dayLines.join("\n"));
    }
  }

  console.log(`\n${DRY_RUN ? "Would import" : "Imported"}: ${slotsWritten} lunch slots across ${weeksWithData} weeks (${itemsWritten} menu items)`);
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
