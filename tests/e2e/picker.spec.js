import { test, expect } from '@playwright/test';
import { selectProjection } from './projection-picker.js';

async function ready(page) {
  await page.goto('/');
  await expect(page.locator('#search-a')).toBeEnabled();
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-render-mode', /texture|vector/);
}

test('compact picker floats over the map without reducing projection space', async ({ page }) => {
  await ready(page);
  const input = page.getByRole('combobox', { name: 'First projection', exact: true });
  const stage = page.locator('#map-a .map-stage');
  const before = await stage.boundingBox();
  expect((await page.locator('#map-a .projection-controls').boundingBox()).height).toBeLessThan(112);
  expect(before.height).toBeGreaterThan(650);
  await input.click();
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('listbox', { name: 'First projection choices' })).toBeVisible();
  expect(await page.locator('#select-a [role="option"]').count()).toBeGreaterThan(60);
  expect(await stage.boundingBox()).toEqual(before);
  await page.screenshot({ path: 'test-results/compact-picker.png' });
  await input.press('Escape');
  await page.getByRole('button', { name: 'Compare side by side' }).click();
  for (const id of ['a', 'b']) {
    expect((await page.locator(`#map-${id} .projection-controls`).boundingBox()).height).toBeLessThan(112);
    expect((await page.locator(`#map-${id} .map-stage`).boundingBox()).height).toBeGreaterThan(450);
  }
  await page.screenshot({ path: 'test-results/compact-comparison.png' });
});

test('combobox supports arrows, Home, End, Enter, Escape, Tab, and outside dismissal', async ({ page }) => {
  await ready(page);
  const input = page.locator('#search-a');
  const stage = page.locator('#map-a .map-stage');
  const original = await input.inputValue();
  const projection = await stage.getAttribute('data-projection');
  await input.fill('mercator');
  await input.press('Escape');
  await expect(input).toHaveValue(original);
  await expect(input).toBeFocused();
  await expect(stage).toHaveAttribute('data-projection', projection);
  await expect(input).not.toHaveAttribute('aria-activedescendant');
  await input.press('ArrowDown');
  await input.press('Home');
  const options = page.locator('#select-a [role="option"]');
  await expect(input).toHaveAttribute('aria-activedescendant', await options.first().getAttribute('id'));
  await input.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant', await options.nth(1).getAttribute('id'));
  await input.press('ArrowUp');
  await expect(input).toHaveAttribute('aria-activedescendant', await options.first().getAttribute('id'));
  await input.press('End');
  await expect(input).toHaveAttribute('aria-activedescendant', await options.last().getAttribute('id'));
  const selected = await options.last().getAttribute('data-value');
  const name = await options.last().locator('span').first().textContent();
  await input.press('Enter');
  await expect(stage).toHaveAttribute('data-projection', selected);
  await expect(input).toHaveValue(name);
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await input.press('ArrowUp');
  await input.press('Tab');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await expect(input).not.toBeFocused();
  const toggle = page.getByRole('button', { name: 'Show first projection choices' });
  await toggle.click();
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await stage.click({ position: { x: 10, y: 10 } });
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await expect(input).toHaveValue(name);
});

test('projection notes are available without shrinking or misaligning the maps', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: 'Compare side by side' }).click();
  await selectProjection(page, '#select-b', 'cahillKeyes');
  const stage = page.locator('#map-b .map-stage');
  const before = await stage.boundingBox();
  expect(before.y).toBe((await page.locator('#map-a .map-stage').boundingBox()).y);
  const info = page.getByLabel('About second projection');
  await info.click();
  await expect(page.locator('#map-b .projection-description')).toBeVisible();
  expect(await stage.boundingBox()).toEqual(before);
  await info.press('Escape');
  await expect(page.locator('#map-b .projection-description')).toBeHidden();
  await info.click();
  await page.locator('#search-b').click();
  await expect(page.locator('#map-b .projection-description')).toBeHidden();
  await expect(page.locator('#search-b')).toHaveAttribute('aria-expanded', 'true');
});

test.describe('touch projection picker', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('both comparison dropdowns fit the viewport and support touch selection', async ({ page }) => {
    await ready(page);
    await page.getByRole('button', { name: 'Compare side by side' }).tap();
    for (const [slot, label, query, id] of [
      ['a', 'first', 'butterfly', 'collignonButterfly'],
      ['b', 'second', 'Cahill Hayes', 'cahillKeyes'],
    ]) {
      const stage = page.locator(`#map-${slot} .map-stage`);
      const before = await stage.boundingBox();
      await page.getByRole('button', { name: `Show ${label} projection choices` }).tap();
      const popup = await page.locator(`#map-${slot} .projection-popup`).boundingBox();
      expect(popup.x).toBeGreaterThanOrEqual(0);
      expect(popup.x + popup.width).toBeLessThanOrEqual(390);
      expect(await stage.boundingBox()).toEqual(before);
      await page.locator(`#search-${slot}`).fill(query);
      await page.locator(`#select-${slot} [data-value="${id}"]`).tap();
      await expect(stage).toHaveAttribute('data-projection', id);
      await expect(page.locator(`#search-${slot}`)).toHaveAttribute('aria-expanded', 'false');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: 'test-results/compact-comparison-mobile.png', fullPage: true });
  });
});
