import { test, expect } from '@playwright/test';
import { selectProjection } from './projection-picker.js';

async function ready(page) {
  await page.goto('/');
  await expect(page.locator('#search-a')).toBeEnabled();
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-render-mode', /texture|vector/);
}

async function assertPainted(page, selector) {
  await expect.poll(() => page.locator(selector).evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let i = 3; i < pixels.length; i += 64) if (pixels[i]) painted++;
    return painted;
  })).toBeGreaterThan(20);
}

test('search by name, alias, family, and property; recover from empty results', async ({ page }) => {
  await ready(page);
  const search = page.locator('#search-a');
  await search.click();
  const projectionCount = await page.locator('#select-a [role="option"]').count();
  await search.fill('Cahill Hayes');
  await expect(page.locator('#select-a [role="option"]')).toHaveCount(1);
  await search.press('Enter');
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-projection', 'cahillKeyes');
  await expect(page.locator('#map-a .family')).toHaveText('Polyhedral');
  await search.fill('equal area cylindrical');
  for (const id of ['hoboDyer', 'gallPeters', 'cylindricalEqualArea']) await expect(page.locator(`#select-a [data-value="${id}"]`)).toBeVisible();
  await expect(page.locator('#select-a [data-value="mercator"]')).toHaveCount(0);
  await search.fill('not-a-projection');
  await expect(search).toBeEnabled();
  await expect(page.locator('#map-a .projection-empty')).toBeVisible();
  await expect(search).not.toHaveAttribute('aria-activedescendant');
  await expect(page.locator('#map-a .catalog-count')).toHaveText(`0 / ${projectionCount} found`);
  await search.press('Enter');
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-projection', 'cahillKeyes');
  await page.getByRole('button', { name: 'Clear first projection search' }).click();
  await expect(page.locator('#select-a [role="option"]')).toHaveCount(projectionCount);
  await expect(page.locator('#select-a [data-value="cahillKeyes"]')).toHaveAttribute('aria-selected', 'true');
  await search.press('Escape');
  await expect(search).toHaveValue(/Cahill/);
});

test('Cahill–Keyes stays interactive while its texture loads; texture and overlay render', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await ready(page);
  await selectProjection(page, '#select-a', 'cahillKeyes');
  await assertPainted(page, '#map-a .map-overlay');
  const coordinates = await page.locator('#coordinates').textContent();
  await page.locator('#map-a .map-stage').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#coordinates')).not.toHaveText(coordinates);
  await page.getByRole('button', { name: 'Zoom in first map', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reset first map zoom' })).toHaveText('120%');
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-render-mode', 'texture', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Reset view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reset first map zoom' })).toHaveText('100%');
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-texture-size', '768', { timeout: 60_000 });
  await page.screenshot({ path: 'test-results/cahill-keyes.png' });
  expect(errors).toEqual([]);
});

test('comparison has a centered miniature globe, independent projections and zoom, shared rotation', async ({ page }) => {
  await ready(page);
  await selectProjection(page, '#select-a', 'naturalEarth');
  await page.getByRole('button', { name: 'Compare side by side' }).click();
  await expect(page.locator('#map-b')).toBeVisible();
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-projection', 'naturalEarth');
  const firstName = await page.locator('#search-a').inputValue();
  await selectProjection(page, '#select-b', 'waterman');
  await page.locator('#search-b').fill('waterman');
  await expect(page.locator('#search-a')).toHaveValue(firstName);
  const globe = await page.locator('#globe-stage').boundingBox();
  const first = await page.locator('#map-a').boundingBox();
  const second = await page.locator('#map-b').boundingBox();
  expect(globe.width).toBeLessThan(200);
  expect(Math.abs(globe.x + globe.width / 2 - 720)).toBeLessThan(2);
  expect(globe.y + globe.height).toBeLessThanOrEqual(first.y);
  expect(Math.abs(first.y - second.y)).toBeLessThan(2);
  expect(Math.abs(first.x + first.width - second.x)).toBeLessThan(2);
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-render-mode', 'texture', { timeout: 60_000 });
  await expect(page.locator('#map-b .map-stage')).toHaveAttribute('data-render-mode', 'texture', { timeout: 60_000 });
  const beforeA = await page.locator('#map-a .map-overlay').evaluate(canvas => canvas.toDataURL());
  const beforeB = await page.locator('#map-b .map-overlay').evaluate(canvas => canvas.toDataURL());
  const stage = await page.locator('#map-b .map-stage').boundingBox();
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width / 2 + 40, stage.y + stage.height / 2 + 20, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => page.locator('#map-a .map-overlay').evaluate(canvas => canvas.toDataURL())).not.toBe(beforeA);
  await expect.poll(() => page.locator('#map-b .map-overlay').evaluate(canvas => canvas.toDataURL())).not.toBe(beforeB);
  await page.getByRole('button', { name: 'Zoom in second map', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reset second map zoom' })).toHaveText('120%');
  await expect(page.getByRole('button', { name: 'Reset first map zoom' })).toHaveText('100%');
  await page.screenshot({ path: 'test-results/comparison.png' });
  await page.getByRole('button', { name: 'Explore', exact: true }).click();
  await expect(page.locator('#map-b')).toBeHidden();
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-projection', 'naturalEarth');
  await page.getByRole('button', { name: 'Compare side by side' }).click();
  await expect(page.locator('#map-b .map-stage')).toHaveAttribute('data-projection', 'waterman');
  await expect(page.getByRole('button', { name: 'Reset second map zoom' })).toHaveText('120%');
});

test('all catalog projections draw textures and overlays without runtime errors', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await ready(page);
  const catalog = await page.evaluate(() => fetch('./projections.json').then(response => response.json()));
  for (const definition of catalog) {
    await selectProjection(page, '#select-a', definition.id);
    await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-projection', definition.id);
    await assertPainted(page, '#map-a .map-overlay');
    await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-render-mode', 'texture', { timeout: 30_000 });
  }
  expect(errors).toEqual([]);
});

test('mobile comparison remains side by side without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await page.getByRole('button', { name: 'Compare side by side' }).click();
  const a = await page.locator('#map-a').boundingBox();
  const b = await page.locator('#map-b').boundingBox();
  expect(a.y).toBe(b.y);
  expect(a.x + a.width).toBe(b.x);
  expect(b.x + b.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await assertPainted(page, '#map-b .map-overlay');
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
});

test('missing Earth images keep a usable vector map', async ({ page }) => {
  await page.route('**/earth-blue-marble.jpg', route => route.abort());
  await page.route('**/land_ocean_ice_cloud_2048.jpg', route => route.abort());
  await ready(page);
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-render-mode', 'vector');
  await selectProjection(page, '#select-a', 'cahillKeyes');
  await assertPainted(page, '#map-a .map-overlay');
  await page.locator('#map-a .map-stage').press('ArrowDown');
  await page.getByRole('button', { name: 'Compare side by side' }).click();
  await assertPainted(page, '#map-b .map-overlay');
});
