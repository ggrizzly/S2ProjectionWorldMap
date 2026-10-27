import { test, expect } from '@playwright/test';

async function ready(page) {
  await page.goto('/');
  await expect(page.locator('#select-a')).toBeEnabled();
}

test('Africa is initially at the front; projection changes restore recommended orientations', async ({ page }) => {
  await ready(page);
  await expect(page.locator('#coordinates')).toHaveText('20.0° E · 0.0° N');
  await expect(page.getByRole('checkbox', { name: 'Lock orientation' })).not.toBeChecked();
  await page.locator('#globe-stage').press('ArrowRight');
  await expect(page.locator('#coordinates')).not.toHaveText('20.0° E · 0.0° N');
  await page.selectOption('#select-a', 'mercator');
  await expect(page.locator('#coordinates')).toHaveText('20.0° E · 0.0° N');
  await page.selectOption('#select-a', 'cahillKeyes');
  await expect(page.locator('#coordinates')).toHaveText('20.0° W · 0.0° N');
});

async function dragMap(page, selector, dx, dy, modifiers = []) {
  const rect = await page.locator(selector).boundingBox();
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + dx, rect.y + rect.height / 2 + dy, { steps: 4 });
  await page.mouse.up();
  for (const modifier of modifiers) await page.keyboard.up(modifier);
}

test('R G Z C shortcuts reset, toggle graticules, cycle all zooms, and toggle comparison', async ({ page }) => {
  await ready(page);
  await page.locator('#globe-stage').focus();
  await page.keyboard.press('c');
  await expect(page.locator('#map-b')).toBeVisible();
  for (const zoom of [2, 4, 8, 1]) {
    await page.keyboard.press('z');
    await expect(page.locator('#globe-stage')).toHaveAttribute('data-zoom', String(zoom));
    for (const map of ['a', 'b']) await expect(page.getByRole('button', { name: `Reset ${map === 'a' ? 'first' : 'second'} map zoom` })).toHaveText(`${zoom * 100}%`);
    await expect(page.getByRole('button', { name: 'Cycle zoom levels' })).toHaveText(`${zoom * 100}%`);
  }
  await page.keyboard.press('g');
  await expect(page.getByRole('checkbox', { name: 'Graticule' })).not.toBeChecked();
  await expect(page.locator('#globe-stage')).toHaveAttribute('data-graticule', 'false');
  await page.keyboard.press('G');
  await expect(page.getByRole('checkbox', { name: 'Graticule' })).toBeChecked();
  await page.keyboard.press('z');
  await page.locator('#globe-stage').press('ArrowRight');
  await expect(page.locator('#coordinates')).not.toHaveText('20.0° E · 0.0° N');
  await dragMap(page, '#map-a .map-stage', 40, 25);
  await page.keyboard.press('r');
  await expect(page.locator('#coordinates')).toHaveText('20.0° E · 0.0° N');
  for (const selector of ['#map-a .map-stage', '#map-b .map-stage', '#globe-stage']) await expect(page.locator(selector)).toHaveAttribute('data-zoom', '1');
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-pan-x', '0');
  await page.keyboard.press('c');
  await expect(page.locator('#map-b')).toBeHidden();
});

test('shortcuts do not fire while typing in a search box or selecting a projection', async ({ page }) => {
  await ready(page);
  await page.locator('#search-a').fill('');
  await page.locator('#search-a').pressSequentially('rgzc');
  await expect(page.locator('#search-a')).toHaveValue('rgzc');
  await expect(page.locator('#map-b')).toBeHidden();
  await expect(page.getByRole('checkbox', { name: 'Graticule' })).toBeChecked();
  await expect(page.locator('#globe-stage')).toHaveAttribute('data-zoom', '1');
  await page.locator('#search-a').press('Escape');
  await page.locator('#select-a').focus();
  await page.keyboard.press('g');
  await expect(page.getByRole('checkbox', { name: 'Graticule' })).toBeChecked();
});

test('zoomed maps pan independently; shift-drag rotates instead; reset clears pan', async ({ page }) => {
  await ready(page);
  await page.locator('#globe-stage').press('c');
  await page.keyboard.press('z');
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-zoom', '2');
  const coordinates = await page.locator('#coordinates').textContent();
  await dragMap(page, '#map-a .map-stage', 48, 32);
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-pan-x', '48');
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-pan-y', '32');
  await expect(page.locator('#map-b .map-stage')).toHaveAttribute('data-pan-x', '0');
  await expect(page.locator('#coordinates')).toHaveText(coordinates);
  await page.locator('#map-a .map-stage').press('ArrowRight');
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-pan-x', '78');
  await dragMap(page, '#map-a .map-stage', 20, 10, ['Shift']);
  await expect(page.locator('#coordinates')).not.toHaveText(coordinates);
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-pan-x', '78');
  await page.screenshot({ path: 'test-results/panned-comparison.png' });
  await page.getByRole('button', { name: 'Reset first map zoom' }).click();
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-pan-x', '0');
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-zoom', '1');
  await expect(page.locator('#map-b .map-stage')).toHaveAttribute('data-zoom', '2');
});

test('wheel zoom anchors to the cursor and button zoom preserves the panned viewport center', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: 'Zoom in first map', exact: true }).click();
  const stage = page.locator('#map-a .map-stage');
  await expect(stage).toHaveAttribute('data-zoom', '1.2');
  const rect = await stage.boundingBox();
  const anchor = [rect.width * 0.3, rect.height * 0.35];
  await page.mouse.move(rect.x + anchor[0], rect.y + anchor[1]);
  await page.mouse.wheel(0, -120);
  await expect.poll(() => stage.getAttribute('data-zoom')).not.toBe('1.2');
  const state = await stage.evaluate(element => ({ zoom: +element.dataset.zoom, pan: [+element.dataset.panX, +element.dataset.panY] }));
  for (let axis = 0; axis < 2; axis++) {
    const center = [rect.width / 2, rect.height / 2][axis];
    expect((anchor[axis] - center - state.pan[axis]) / state.zoom).toBeCloseTo((anchor[axis] - center) / 1.2, 1);
  }
  await page.getByRole('button', { name: 'Zoom in first map', exact: true }).click();
  await expect.poll(() => stage.getAttribute('data-zoom')).not.toBe(String(state.zoom));
  const newPan = await stage.evaluate(element => [+element.dataset.panX, +element.dataset.panY]);
  expect(newPan[0]).toBeCloseTo(state.pan[0] * 1.2, 1);
  expect(newPan[1]).toBeCloseTo(state.pan[1] * 1.2, 1);
});

test('Alt-drag pans even at 100 percent without changing the globe orientation', async ({ page }) => {
  await ready(page);
  await dragMap(page, '#map-a .map-stage', 36, 20, ['Alt']);
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-pan-x', '36');
  await expect(page.locator('#coordinates')).toHaveText('20.0° E · 0.0° N');
});

test('orientation lock preserves position across projection changes; unlocking restores defaults', async ({ page }) => {
  await ready(page);
  await page.locator('#globe-stage').press('ArrowRight');
  await expect(page.locator('#coordinates')).not.toHaveText('20.0° E · 0.0° N');
  const rotated = await page.locator('#coordinates').textContent();
  await page.getByRole('checkbox', { name: 'Lock orientation' }).check();
  await page.selectOption('#select-a', 'collignonButterfly');
  await expect(page.locator('#coordinates')).toHaveText(rotated);
  await page.getByRole('button', { name: 'Compare side by side' }).click();
  await page.selectOption('#select-b', 'cahillKeyes');
  await expect(page.locator('#coordinates')).toHaveText(rotated);
  await page.getByRole('checkbox', { name: 'Lock orientation' }).uncheck();
  await expect(page.locator('#coordinates')).toHaveText('20.0° W · 0.0° N');
});
