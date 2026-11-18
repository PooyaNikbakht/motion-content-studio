import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

// Throwaway local test passwords (the e2e run resets the local D1 first). Min length is 10.
export const PASSWORD = "e2e-password-one";
export const PASSWORD_2 = "e2e-password-two";

/** RECOVERY_KEY from .dev.vars. Never log it. */
export function recoveryKey(): string {
  const text = readFileSync(join(__dirname, "..", ".dev.vars"), "utf8");
  const m = text.match(/^\s*RECOVERY_KEY\s*=\s*(.*)$/m);
  if (!m) throw new Error("RECOVERY_KEY is missing from .dev.vars");
  return m[1].trim().replace(/^["']|["']$/g, "");
}

/** 1x1 PNG, enough for the thumbnail pipeline. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

export async function noHorizontalScroll(page: Page) {
  const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(w.scroll, "page is wider than the viewport").toBeLessThanOrEqual(w.client + 1);
}

/** Opens /login and gets signed in, creating the password on a first run. Leaves the page on /app. */
export async function signIn(page: Page) {
  await page.goto("/login");
  if (new URL(page.url()).pathname === "/app") return;
  if (await page.getByRole("heading", { name: "Create password" }).isVisible()) {
    await page.getByLabel("Recovery key").fill(recoveryKey());
    await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirm password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create password" }).click();
  } else {
    await page.getByLabel("Current password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/app/);
  await expect(page.locator("#sb-toggle")).toBeVisible();
}

/** New project through the sidebar dialog; ends on the new project. */
export async function newProject(page: Page, name: string) {
  const open = page.locator("#p-new");
  if (!(await open.isVisible())) await page.locator("#sb-toggle").click(); // narrow screens: the list is a drawer
  await open.click();
  await page.locator("#dlg-in").fill(name);
  await page.locator("#dlg").getByRole("button", { name: "Create" }).click();
  await expect(page.locator("#dlg")).not.toBeVisible();
}

/** Load sample on Import & Parse, confirming the replace dialog if one shows. */
export async function loadSample(page: Page) {
  await page.locator("#tab-import").click();
  await page.locator("#mode-paste").click(); // a new project opens in AI Director mode; Load sample lives in Paste Conversation
  await page.locator("#load-sample").click();
  const dlg = page.locator("#dlg");
  if (await dlg.isVisible().catch(() => false)) await dlg.locator('[data-x="ok"]').click();
  await expect(page.locator("#parse-badge")).toHaveText("Parsed");
}
