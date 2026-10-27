import { test, expect } from '@playwright/test';

test('unavailable WebGL keeps both maps and a vector globe interactive', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type.startsWith('webgl') ? null : original.call(this, type, ...args);
    };
  });
  await page.goto('/');
  await expect(page.locator('#select-a')).toBeEnabled();
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-render-mode', 'vector');
  await page.getByRole('button', { name: 'Compare side by side' }).click();
  await page.selectOption('#select-b', 'cahillKeyes');
  await expect(page.locator('#map-b .map-stage')).toHaveAttribute('data-render-mode', 'vector');
  const before = await page.locator('#coordinates').textContent();
  await page.locator('#globe-stage').press('ArrowLeft');
  await expect(page.locator('#coordinates')).not.toHaveText(before);
  await expect(page.locator('#app-error')).toBeHidden();
});

test('failed texture workers leave vector maps and report the fallback', async ({ page }) => {
  await page.route('**/texture-worker.js', route => route.abort());
  await page.goto('/');
  await expect(page.locator('#select-a')).toBeEnabled();
  await expect(page.locator('#map-a .map-status')).toContainText('Texture worker unavailable');
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-render-mode', 'vector');
  await page.selectOption('#select-a', 'cahillKeyes');
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-render-mode', 'vector');
  const before = await page.locator('#coordinates').textContent();
  await page.locator('#map-a .map-stage').press('ArrowUp');
  await expect(page.locator('#coordinates')).not.toHaveText(before);
});

test('rapid selections and identical comparison projections do not apply stale lookups', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#select-a')).toBeEnabled();
  await page.selectOption('#select-a', 'cahillKeyes');
  await page.selectOption('#select-a', 'authaGraph');
  await page.selectOption('#select-a', 'equalEarth');
  await page.getByRole('button', { name: 'Compare side by side' }).click();
  await page.selectOption('#select-b', 'equalEarth');
  for (const id of ['a', 'b']) {
    await expect(page.locator(`#map-${id} .map-stage`)).toHaveAttribute('data-projection', 'equalEarth');
    await expect(page.locator(`#map-${id} .map-stage`)).toHaveAttribute('data-render-mode', 'texture');
    await expect(page.locator(`#map-${id} .map-stage`)).toHaveAttribute('data-texture-size', '384');
    await expect(page.locator(`#map-${id} .map-status`)).toHaveText('');
  }
  const withGrid = await page.locator('#map-a .map-overlay').evaluate(canvas => canvas.toDataURL());
  await page.getByRole('checkbox', { name: 'Graticule' }).uncheck();
  await expect.poll(() => page.locator('#map-a .map-overlay').evaluate(canvas => canvas.toDataURL())).not.toBe(withGrid);
  await page.getByRole('checkbox', { name: 'Graticule' }).check();
  await page.setViewportSize({ width: 1000, height: 760 });
  await expect(page.locator('#map-b .map-overlay')).toBeVisible();
  expect(errors).toEqual([]);
});

test('reselecting a cached preview resumes detailed texture preparation', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#select-a')).toBeEnabled();
  await page.selectOption('#select-a', 'cahillKeyes');
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-texture-size', '256');
  await page.selectOption('#select-a', 'mercator');
  await page.selectOption('#select-a', 'cahillKeyes');
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-texture-size', '768', { timeout: 60_000 });
});
