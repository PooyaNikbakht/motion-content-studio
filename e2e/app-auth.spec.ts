import { test, expect } from "@playwright/test";
import { PASSWORD, PASSWORD_2, recoveryKey } from "./helpers";

// One password row in local D1, so this runs once (desktop) and in order. `npm run e2e` clears the row first.
// Traces, screenshots and video are off here because the form is filled with the recovery key.
test.use({ trace: "off", screenshot: "off", video: "off" });
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "auth runs once, on desktop");
});

test("/app redirects to /login when signed out", async ({ page }) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login/);
});

test("first run: create the password with the recovery key", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Create password" })).toBeVisible();

  await page.getByLabel("Recovery key").fill("definitely-not-the-key");
  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create password" }).click();
  await expect(page.getByRole("alert")).toContainText("recovery key is not right");

  await page.getByLabel("Recovery key").fill(recoveryKey());
  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create password" }).click();
  await expect(page).toHaveURL(/\/app/);
});

test("sign out, wrong password fails, right password signs in", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Current password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/app/);

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel("Current password").fill("wrong-password-here");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("password is not right");
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel("Current password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/app/);
});

test("change password, then change it back", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Current password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/app/);

  const change = async (from: string, to: string) => {
    await page.goto("/login?mode=change");
    await page.getByLabel("Current password").fill(from);
    await page.getByLabel("New password", { exact: true }).fill(to);
    await page.getByLabel("Confirm password").fill(to);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page).toHaveURL(/\/app/);
  };
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: /Change password/ }).click();
  await expect(page.getByRole("heading", { name: "Change password" })).toBeVisible();
  await change(PASSWORD, PASSWORD_2);
  await change(PASSWORD_2, PASSWORD); // leave the known password for the other specs
});
