import { test, expect } from "@playwright/test";
import { PNG, loadSample, newProject, noHorizontalScroll, signIn } from "./helpers";

test("app: upload an image to a scene slot, preview it, remove it", async ({ page }) => {
  await signIn(page);
  await newProject(page, "e2e media " + Date.now());
  await loadSample(page);

  await page.locator("#tab-youtube").click();
  await page.locator("#subtab-youtube-board").click();

  const slot = page.locator('.mslot[data-slot="s-1-image"]');
  await expect(slot).toHaveAttribute("data-state", "empty");
  const chip = page.locator('input[data-n="1"][data-kind="image"]');
  await expect(chip).not.toBeChecked();

  await slot.locator("[data-slot-input]").setInputFiles({ name: "e2e.png", mimeType: "image/png", buffer: PNG });
  await expect(slot).toHaveAttribute("data-state", "filled", { timeout: 20_000 });
  await expect(slot.locator(".mslot-thumb img")).toBeVisible();
  await expect(chip).toBeChecked();

  if ((page.viewportSize()?.width ?? 0) <= 400) await noHorizontalScroll(page);

  await slot.locator(".mslot-thumb").click();
  const lightbox = page.locator("#lightbox");
  await expect(lightbox).toBeVisible();
  await lightbox.locator("[data-lb-close]").click();
  await expect(lightbox).not.toBeVisible();

  await slot.locator('[data-sa="remove"]').click();
  await page.locator("#dlg").locator('[data-x="ok"]').click();
  await expect(slot).toHaveAttribute("data-state", "empty");
  await expect(chip).not.toBeChecked();
});
