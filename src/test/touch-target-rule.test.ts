import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Conditional 44px sizing is the defect this rule exists to prevent: a control
 * sized correctly at lg: while staying 32-40px on the phones the family uses.
 * If a genuine large-screen enhancement needs one of these, it must sit on top of
 * a base that already meets 44px — add the file to ALLOWED with a reason. */
const BANNED = /\blg:(?:min-)?[hw]-11\b/;
const ALLOWED = new Set<string>([]);

describe("touch-target rule", () => {
  it("has no lg:-only 44px sizing left in components", () => {
    const files = globSync("src/**/*.tsx", { cwd: process.cwd() }).filter(
      (f) => !f.includes(".test."),
    );
    const offenders = files.filter((f) => {
      if (ALLOWED.has(f)) return false;
      return BANNED.test(readFileSync(join(process.cwd(), f), "utf8"));
    });
    expect(offenders, "files sizing touch targets only at lg:").toEqual([]);
  });
});
