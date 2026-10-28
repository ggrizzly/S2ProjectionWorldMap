import { test, expect } from '@playwright/test';
import { selectProjection } from './projection-picker.js';

for (const id of ['waterman', 'collignonButterfly']) {
  test(`${id}: texture follows diagonal edges, not rectangular lookup cells`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#search-a')).toBeEnabled();
    await selectProjection(page, '#select-a', id);
    const stage = page.locator('#map-a .map-stage');
    await expect(stage).toHaveAttribute('data-texture-size', '768');
    await expect(stage).toHaveAttribute('data-render-mode', 'texture');
    await page.getByRole('button', { name: 'Zoom in first map', exact: true }).click();
    const rect = await stage.boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2 + 35, rect.y + rect.height / 2 + 20, { steps: 3 });
    await page.mouse.up();
    await expect(stage).toHaveAttribute('data-pan-x', '35');
    const screenshot = await stage.screenshot({ scale: 'css' });
    const result = await page.evaluate(async dataURL => {
      const stage = document.querySelector('#map-a .map-stage');
      const clip = stage.querySelector('.map-texture').style.clipPath;
      const match = clip.match(/^path\((["'])(.*)\1\)$/);
      if (!match) throw new Error('Map texture has no exact vector clip');
      const image = new Image();
      image.src = dataURL;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      context.clearRect(0, 0, canvas.width, canvas.height);
      const boundary = new Path2D(match[2]);
      context.fill(boundary);
      context.lineWidth = 8; context.stroke(boundary); // Ignore antialiasing and the vector outline.
      const mask = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let outside = 0, leaks = 0;
      for (let y = 5; y < canvas.height - 5; y += 2) for (let x = 5; x < canvas.width - 5; x += 2) {
        const i = (y * canvas.width + x) * 4;
        if (mask[i + 3]) continue;
        outside++;
        if (Math.abs(pixels[i] - 16) + Math.abs(pixels[i + 1] - 24) + Math.abs(pixels[i + 2] - 34) > 8) leaks++;
      }
      return { outside, leaks };
    }, `data:image/png;base64,${screenshot.toString('base64')}`);
    expect(result.outside).toBeGreaterThan(1000);
    expect(result.leaks).toBeLessThan(5);
    await page.screenshot({ path: `test-results/${id}-sharp-panned.png` });
  });
}
