#!/usr/bin/env node
// Turns a daily backup (db/YYYY-MM-DD.json, see src/backup.js) into a SQL file for `wrangler d1 execute`.
//
//   npx wrangler r2 object get motion-books-backups/db/2026-11-18.json --file .local/db-2026-11-18.json --remote
//   node scripts/restore-db-from-backup.mjs .local/db-2026-11-18.json                 writes .local/restore-2026-11-18.sql
//   node scripts/restore-db-from-backup.mjs .local/db-2026-11-18.json --wipe          also empties each table first
//   node scripts/restore-db-from-backup.mjs <backup.json> --out .local/other.sql
//   npx wrangler d1 execute motion-books --remote --file .local/restore-2026-11-18.sql
//
// Uses INSERT OR REPLACE, so rows that still exist are overwritten and --wipe is only needed to drop rows added after the backup.
// The backup holds private data (project text, the Master Prompt, the password hash and salt): the output stays under .local/
// (git-ignored) and this script prints counts only, never contents. Create the tables first (npm run db:migrate:remote) on a fresh database.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, relative, basename } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
const wipe = args.includes("--wipe");
const die = (m) => { console.error(m); process.exit(1); };
if (!file) die("Usage: node scripts/restore-db-from-backup.mjs <db-backup.json> [--wipe] [--out .local/file.sql]");

const day = (/(\d{4}-\d{2}-\d{2})/.exec(basename(file)) || [])[1] || "backup";
const out = resolve(opt("--out") || `.local/restore-${day}.sql`);
const rel = relative(resolve(".local"), out);
if (rel.startsWith("..") || rel === "") die("The output must be inside .local/ (git-ignored).");

let data;
try { data = JSON.parse(await readFile(file, "utf8")); } catch { die("Cannot read " + file + " as JSON."); }
if (!data || data.format !== 1 || typeof data.tables !== "object") die("Not a backup file made by this app.");

const ident = (s) => { if (!/^[A-Za-z0-9_]+$/.test(s)) die("Unexpected name in the backup."); return '"' + s + '"'; };
const lit = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") { if (!Number.isFinite(v)) die("Unexpected number in the backup."); return String(v); }
  if (typeof v === "boolean") return v ? "1" : "0";
  return "'" + String(v).replace(/'/g, "''") + "'";
};

const lines = ["PRAGMA defer_foreign_keys = on;"];
const counts = {};
for (const [table, rows] of Object.entries(data.tables)) {
  const t = ident(table);
  if (wipe) lines.push(`DELETE FROM ${t};`);
  for (const row of rows) {
    const cols = Object.keys(row);
    lines.push(`INSERT OR REPLACE INTO ${t} (${cols.map(ident).join(", ")}) VALUES (${cols.map((c) => lit(row[c])).join(", ")});`);
  }
  counts[table] = rows.length;
}
await mkdir(dirname(out), { recursive: true });
await writeFile(out, lines.join("\n") + "\n", { mode: 0o600 });
console.log("Wrote " + relative(process.cwd(), out) + " (schema " + (data.schemaVersion || "unknown") + ", " + (wipe ? "with" : "without") + " --wipe).");
console.log(Object.entries(counts).map(([k, n]) => k + ": " + n).join(", "));
