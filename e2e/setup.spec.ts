import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/demo#setup");
  await expect(page.locator("#tab-setup")).toHaveAttribute("aria-selected", "true");
});

test("setup cards collapse and expand", async ({ page }) => {
  const toggle = page.locator('.card-toggle[data-card="set1"]');
  const body = page.locator("#set1-body");
  await expect(toggle).toHaveAttribute("aria-expanded", "true"); // demo: every card starts open
  await expect(body).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(body).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(body).toBeVisible();
});

test("model routing preset dropdown changes the preset", async ({ page }) => {
  await expect(page.locator("#set2-body")).toBeVisible();
  const preset = page.locator("#g-preset");
  await expect(preset).toContainText("Recommended Smart Hybrid");
  await preset.click();
  await page.locator("#g-preset-list").getByRole("option", { name: "All Flash" }).click();
  await expect(preset).toContainText("All Flash");
  await expect(page.locator("#g-preset-hint")).toContainText("Lowest cost");
});
