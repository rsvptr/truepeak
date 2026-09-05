import path from "node:path";
import { expect, test } from "@playwright/test";

const fixturePath = path.join(
  process.cwd(),
  "public",
  "test-audio",
  "alaw-compat-test.wav",
);

const timelineFixturePath = path.join(
  process.cwd(),
  "public",
  "test-audio",
  "timeline-fixture_48k_24bit.wav",
);

async function configureCompatibilityFirst(page) {
  await page.goto("/?ui=advanced");
  await expect(page.locator("#truepeak-main")).toHaveAttribute("data-hydrated", "true");
  await page.getByRole("button", { name: "Advanced options" }).click();
  const decodePath = page.getByLabel("Choose decode path");
  await decodePath.selectOption("compatibility-first");
  await expect(decodePath).toHaveValue("compatibility-first");
}

async function uploadCompatibilityFixture(page) {
  await page
    .locator('input[type="file"][accept^="audio/"]')
    .setInputFiles(fixturePath);
}

test("the root is a cacheable static shell with the real analyzer markup", async ({ page, request }) => {
  const response = await request.get("/");
  expect(response.ok()).toBe(true);
  const cacheControl = response.headers()["cache-control"] ?? "";
  expect(cacheControl).not.toMatch(/private|no-store/i);
  const html = await response.text();
  expect(html).toContain("Choose your files and start the review");
  expect(html).not.toContain("Preparing the analyzer");

  await page.addInitScript(() => {
    window.localStorage.setItem("truepeak-ui-mode", "advanced");
  });
  await page.goto("/");
  await expect(page.locator("#truepeak-main")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByRole("button", { name: "Advanced", exact: true })).toHaveAttribute("aria-pressed", "true");

  const beforeTheme = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('meta[name="theme-color"]'));
    nodes.forEach((node, index) => {
      node.setAttribute("data-wp14b-node", String(index));
    });
    return {
      root: document.documentElement.dataset.theme,
      count: nodes.length,
    };
  });
  expect(beforeTheme.count).toBe(2);
  await page.getByRole("button", { name: "Toggle color theme" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).not.toBe(beforeTheme.root);
  const afterTheme = await page.evaluate(() => Array.from(
    document.querySelectorAll('meta[name="theme-color"]'),
    (node) => ({ marker: node.getAttribute("data-wp14b-node"), content: node.getAttribute("content") }),
  ));
  expect(afterTheme).toHaveLength(2);
  expect(afterTheme.map((entry) => entry.marker)).toEqual(["0", "1"]);
  expect(new Set(afterTheme.map((entry) => entry.content)).size).toBe(1);
});

test("the production bundle completes through the compatibility decoder", async ({ page }) => {
  await configureCompatibilityFirst(page);
  await uploadCompatibilityFixture(page);

  await expect(page.getByText("Compatibility decoder", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/^-?\d+(?:\.\d+)? LUFS$/).first()).toBeVisible();

  await page.getByRole("tab", { name: "Technical" }).click();
  await expect(page.getByText(/Decoder mode:\s*ffmpeg-wasm/)).toBeVisible();
  await expect(page.getByText(/Fallback used after another decoder failed/i)).toHaveCount(0);
});

test("a missing core reports a plain local decoder error", async ({ page }) => {
  await page.route("**/vendor/ffmpeg/core/*/ffmpeg-core.js", (route) =>
    route.fulfill({ status: 404, contentType: "text/plain", body: "missing" }),
  );

  await configureCompatibilityFirst(page);
  await uploadCompatibilityFixture(page);

  await expect(page.getByText("failed", { exact: true }).first()).toBeVisible();
  const overviewPanel = page.getByRole("tabpanel", { name: "Overview" });
  await overviewPanel.getByText("Failure details", { exact: true }).click();
  await expect(
    overviewPanel.getByText(
      /The compatibility decoder core could not load\. Reload the page and try again\./,
    ),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("too dynamic");
});

test("mobile Back dismisses the More sheet and confirmation without leaving the session", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/");
  await expect(page.locator("#truepeak-main")).toHaveAttribute("data-hydrated", "true");
  await uploadCompatibilityFixture(page);
  await expect(page.getByRole("button", { name: "More session actions" })).toBeVisible();

  await page.getByRole("button", { name: "More session actions" }).click();
  await expect(page.getByRole("menu", { name: "Session actions" })).toBeVisible();
  await page.evaluate(() => window.history.back());
  await expect(page.getByRole("menu", { name: "Session actions" })).toHaveCount(0);
  await expect(page).toHaveURL(/screen=session/);

  await page.getByRole("button", { name: "More session actions" }).click();
  await page.getByRole("menuitem", { name: "Clear Session" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Clear the current session?");
  await page.evaluate(() => window.history.back());
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page).toHaveURL(/screen=session/);
  await expect(page.getByRole("button", { name: "More session actions" })).toBeVisible();
});

test("Data Saver keeps the compatibility download opt-in", async ({ page }) => {
  let coreRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/vendor/ffmpeg/core/")) {
      coreRequests += 1;
    }
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: {
        saveData: true,
        effectiveType: "4g",
        addEventListener() {},
        removeEventListener() {},
      },
    });
  });
  await page.goto("/");
  await expect(page.locator("#truepeak-main")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByText(/Data Saver is on.*compatibility decoder will stay off/i)).toBeVisible();
  await page.getByRole("button", { name: "Advanced options" }).click();
  const compatibilityOptIn = page.getByRole("checkbox", {
    name: "Allow compatibility decoder",
  });
  await expect(compatibilityOptIn).not.toBeChecked();
  await compatibilityOptIn.check();
  await expect(compatibilityOptIn).toBeChecked();
  await compatibilityOptIn.uncheck();
  await page.getByLabel("Choose decode path").selectOption("compatibility-first");
  await uploadCompatibilityFixture(page);
  await expect(page.getByText("failed", { exact: true }).first()).toBeVisible();
  await expect(page.locator("body")).toContainText(/skipped the compatibility decoder because Data Saver/i);
  expect(coreRequests).toBe(0);
});

test("the loudness timeline chart draws its LUFS axis", async ({ page }) => {
  // uPlot paints its axis labels on canvas, so the labels are collected from
  // fillText. NaN sentinels reaching the plot leave the loudness scale
  // undefined and no LUFS tick is drawn at all.
  await page.addInitScript(() => {
    const labels = [];
    window.__chartAxisLabels = labels;
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
      labels.push(String(text));
      return fillText.call(this, text, ...rest);
    };
  });
  await page.goto("/");
  await expect(page.locator("#truepeak-main")).toHaveAttribute("data-hydrated", "true");
  await page
    .locator('input[type="file"][accept^="audio/"]')
    .setInputFiles(timelineFixturePath);
  await expect(page.getByText(/^-?\d+(?:\.\d+)? LUFS$/).first()).toBeVisible();

  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page.locator(".uplot canvas")).toHaveCount(2);
  await expect
    .poll(() => page.evaluate(() => new Set(
      window.__chartAxisLabels.filter((label) => label.includes("LUFS")),
    ).size))
    .toBeGreaterThan(1);
});

test.describe("touch input", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("a touch drag moves the timeline cursor readout", async ({ page }) => {
    // uPlot moves its cursor from mouse events only, so the readout under the
    // chart is driven by a touch handler of our own (MOB-11). Touch drags are
    // dispatched over CDP because page.touchscreen only taps.
    await page.goto("/");
    await expect(page.locator("#truepeak-main")).toHaveAttribute("data-hydrated", "true");
    await page
      .locator('input[type="file"][accept^="audio/"]')
      .setInputFiles(timelineFixturePath);
    await expect(page.getByText(/^-?\d+(?:\.\d+)? LUFS$/).first()).toBeVisible();

    await page.getByRole("button", { name: "Inspect timeline-fixture_48k_24bit.wav" }).click();
    await page.getByRole("tab", { name: "Timeline" }).click();
    await expect(page.locator(".uplot canvas")).toHaveCount(2);

    const readout = page.locator('[data-timeline-readout="loudness"]');
    await expect(readout).toBeVisible();
    const initialText = (await readout.innerText()).trim();

    const plotArea = page.locator(".uplot .u-over").first();
    await plotArea.scrollIntoViewIfNeeded();
    const box = await plotArea.boundingBox();
    const touchY = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + box.width - 4, y: touchY }],
    });
    for (const fraction of [0.75, 0.5, 0.25]) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: box.x + box.width * fraction, y: touchY }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    await expect.poll(async () => (await readout.innerText()).trim()).not.toBe(initialText);
    await expect(readout).toContainText(/-?\d+(?:\.\d+)? LUFS/);
  });
});
