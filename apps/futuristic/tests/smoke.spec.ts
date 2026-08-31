import { expect, test } from "@playwright/test";

/**
 * Smoke tests for the AdaanIDE futuristic UI.
 *
 * These verify the app boots and renders the launcher console (WorkspacePicker)
 * which is the first thing a user sees when no workspace is open.
 */
test.describe("AdaanIDE launcher console", () => {
  test("renders the hero title and console panel", async ({ page }) => {
    await page.goto("/");

    // The glitch hero <h1> always contains "AdaanIDE".
    await expect(page.locator("h1.hero-title-glitch")).toContainText("AdaanIDE");

    // The retro console panel should be visible.
    await expect(page.locator(".console-panel")).toBeVisible();
  });

  test("shows the workspace terminal header", async ({ page }) => {
    await page.goto("/");

    // The console header label is always rendered once loading finishes.
    const header = page.getByText("workspace · terminal");
    await expect(header).toBeVisible();
  });

  test("theme is set on <html> via data-theme", async ({ page }) => {
    await page.goto("/");
    const theme = await page.locator("html").getAttribute("data-theme");
    expect(theme).toBeTruthy();
  });
});
