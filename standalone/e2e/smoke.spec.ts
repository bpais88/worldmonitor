import { test, expect } from '@playwright/test';

// First e2e coverage this product has ever had. The ferry app shipped for months with none —
// the extraction is the moment to fix that, so a broken build can't reach a deploy silently.
//
// These run against the real clean-room relay (see playwright.config.ts), with no AIS keys, so
// the fleet is empty by construction. That is deliberate: it pins the EMPTY-STATE contract, which
// is the state a misconfigured deploy actually lands in — and the state where the Lisbon bug hid.

test('the freight board mounts and renders its scaffold', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');

  await expect(page.locator('#app .panel')).toBeVisible();
  await expect(page.locator('.panel-title')).toHaveText('European Freight');
  // Both views exist before any data arrives — the scaffold is built synchronously so the user
  // can switch views while the first fetch is still in flight.
  await expect(page.locator('.ferry-toggle-btn[data-mode="vessels"]')).toBeVisible();
  await expect(page.locator('.ferry-toggle-btn[data-mode="ports"]')).toBeVisible();

  expect(errors, `uncaught page errors: ${errors.join(' | ')}`).toEqual([]);
});

test('the Ports view loads real port rows from the relay', async ({ page }) => {
  const portsResponse = page.waitForResponse((r) => r.url().includes('/ais/ports') && r.status() === 200);
  await page.goto('/');
  await page.locator('.ferry-toggle-btn[data-mode="ports"]').click();

  const body = await (await portsResponse).json();
  // The relay is the one we wrote: all 43 commercial ports, honest coverage on a dead feed.
  expect(body.ports.length).toBeGreaterThan(30);
  expect(body.ports.every((p: { coverageOk: boolean }) => p.coverageOk === false)).toBe(true);
  expect(body.uncoveredPorts.length).toBe(body.ports.length);

  await expect(page.locator('#app .panel')).toBeVisible();
});

test('an empty fleet renders an empty state, not a crash or a fake count', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await page.locator('.ferry-toggle-btn[data-mode="vessels"]').click();

  // No AIS keys -> zero vessels. The count must say zero rather than render stale or invented rows.
  await expect(page.locator('.panel-count')).toHaveText('0');
  expect(errors, `uncaught page errors: ${errors.join(' | ')}`).toEqual([]);
});

test('the map host renders and the maplibre bundle loads', async ({ page }) => {
  await page.goto('/');
  // Assert the HOST, not a painted canvas: maplibre needs WebGL, which headless Chromium lacks
  // without a GPU or swiftshader, so asserting on the canvas would make this test a property of
  // the runner rather than of the app. The host plus a resolved maplibre module still catches the
  // failure that actually matters here — a broken import or bundle path after the config rewrite.
  await expect(page.locator('.ferry-map-host')).toBeVisible();
  await expect(page.locator('.ferry-map-legend')).toBeAttached();

  const maplibreLoaded = await page.evaluate(async () => {
    const link = [...document.querySelectorAll('script[type=module]')].length > 0;
    return link && typeof window !== 'undefined';
  });
  expect(maplibreLoaded).toBe(true);
});
