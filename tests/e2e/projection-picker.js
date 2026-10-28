import { expect } from '@playwright/test';

// Exercise the visible combobox instead of bypassing it through DOM state.
export async function selectProjection(page, listSelector, id) {
  const input = page.locator(listSelector.replace('#select-', '#search-'));
  await input.click();
  await input.fill('');
  await page.locator(`${listSelector} [role="option"][data-value="${id}"]`).click();
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  const slot = listSelector.endsWith('-b') ? 'b' : 'a';
  await expect(page.locator(`#map-${slot} .map-stage`)).toHaveAttribute('data-projection', id);
}
