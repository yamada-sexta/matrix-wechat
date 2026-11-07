import { deepStrictEqual, strictEqual } from "node:assert";

const results = (await Bun.file(process.argv[2]).text())
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const raw = Buffer.from(await Bun.file(process.argv[3]).arrayBuffer());
// Same SQLite handle's exact binary doubles, independently read by the C++ test
// harness. Parsing JSON must preserve them even under non-C locales/rounding.
const expected = Array.from({ length: raw.length / 8 }, (_, i) => raw.readDoubleLE(i * 8));
const actual = results.flatMap((result) =>
  result.rows.flatMap((row: unknown[]) => row.filter((value) => typeof value === "number")),
);
deepStrictEqual(actual, expected);
strictEqual(results.length, 12);
console.log(
  "Native SQLite values, limits, SQL validation, locale/rounding, finalization and DSO unwinding passed",
);
