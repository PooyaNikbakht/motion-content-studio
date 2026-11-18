// Clears the local D1 auth row so the e2e suite starts from the "first run, create a password" state.
// Local only (--local): it never touches a deployed database. Run via `npm run e2e` (pree2e) or by hand.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(root, "node_modules", ".bin", "wrangler");
execFileSync(wrangler, ["d1", "execute", "motion-books", "--local", "--command", "DELETE FROM auth"], { cwd: root, stdio: "inherit" });
console.log("Local auth row cleared.");
