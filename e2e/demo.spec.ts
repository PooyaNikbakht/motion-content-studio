import { test, expect } from "@playwright/test";
import { loadSample, noHorizontalScroll } from "./helpers";

test("demo: loads, parses the sample, navigates, stays local", async ({ page }, info) => {
  const api: string[] = [];
  page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api")) api.push(r.url()); });

  await page.goto("/demo");
  await expect(page.locator("#tab-import")).toBeVisible();

  await loadSample(page);

  for (const id of ["overview", "setup", "import", "youtube", "reels"]) {
    await page.locator("#tab-" + id).click();
    await expect(page.locator("#tab-" + id)).toHaveAttribute("aria-selected", "true");
  }

  // Chip labels are visible text on wide screens (under 400px they are icon-only by design).
  await page.locator("#tab-youtube").click();
  await page.locator("#subtab-youtube-board").click();
  const labels = page.locator(".chip-l");
  await expect(labels.first()).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) > 400) {
    const clipped = await labels.evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).length);
    expect(clipped, "chip labels truncated").toBe(0);
  } else {
    await noHorizontalScroll(page);
  }

  expect(api, "demo must not call /api").toEqual([]);
});

test("demo: no horizontal scroll on the main screens", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) > 400, "360px check");
  await page.goto("/demo");
  await expect(page.locator("#tab-import")).toBeVisible();
  for (const id of ["overview", "setup", "import", "youtube", "reels"]) {
    await page.locator("#tab-" + id).click();
    await noHorizontalScroll(page);
  }
});

test("demo: How it works card opens", async ({ page }) => {
  await page.goto("/demo");
  await page.locator("#tab-import").click();
  const toggle = page.locator("#how-toggle");
  await expect(page.getByRole("heading", { name: "How it works" })).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
  await expect(page.locator("#how-body")).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#how-body")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Paste and Produce" })).toBeVisible();
});
