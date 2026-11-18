import { test, expect } from "@playwright/test";
import { loadSample, newProject, signIn } from "./helpers";

// /app saves on the Save button (or Ctrl/Cmd+S). Edits that are not saved are lost on reload; the browser warns first.
test("app: chips are unsaved until Save, Ctrl+S saves and the saved chip survives a reload", async ({ page }) => {
  await signIn(page);
  await newProject(page, "e2e save " + Date.now());
  await loadSample(page); // Parse saves at once
  await expect(page.locator("#save-btn")).toBeDisabled();

  await page.locator("#tab-youtube").click();
  await page.locator("#subtab-youtube-board").click();
  const chip = page.locator('input[data-n="1"][data-kind="image"]');
  await chip.check({ force: true });
  await expect(page.locator("#save-note")).toHaveText("Unsaved changes");
  await expect(page.locator("#save-btn")).toBeEnabled();

  await page.keyboard.press("Control+S");
  await expect(page.locator("#save-btn")).toHaveText(/Saved/);
  await expect(page.locator("#save-note")).toHaveText("All changes saved");

  page.on("dialog", (d) => d.accept());
  await page.reload();
  await page.locator("#tab-youtube").click();
  await page.locator("#subtab-youtube-board").click();
  await expect(chip).toBeChecked();
});

test("app: Setup has its own Save button", async ({ page }) => {
  await signIn(page);
  await page.locator("#tab-setup").click();
  await expect(page.locator("#save-btn")).toBeDisabled();
  await page.locator("#s-voice").fill("e2e-voice");
  await expect(page.locator("#save-note")).toHaveText("Unsaved changes");
  await page.locator("#save-btn").click();
  await expect(page.locator("#save-btn")).toHaveText(/Saved/);
});

test("app: no keyboard-shortcuts button and an account menu holds Sign out", async ({ page }) => {
  await signIn(page);
  await expect(page.locator("#help-open")).toHaveCount(0);
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeHidden();
});
