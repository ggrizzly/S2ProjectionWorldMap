import { test, expect } from '@playwright/test';

test('Cahill–Keyes numerical fallback fills the projection interior', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const geo = await import('d3-geo');
    const extended = await import('d3-geo-projection');
    const polyhedral = await import('d3-geo-polygon');
    const { canonicalProjection, validInverse, createInverter } = await import('/projection-engine.js');
    const catalog = await fetch('/projections.json').then(response => response.json());
    const definition = catalog.find(item => item.id === 'cahillKeyes');
    const projection = canonicalProjection(definition, { geo, extended, polyhedral });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 512;
    const context = canvas.getContext('2d');
    context.beginPath(); geo.geoPath(projection, context)({ type: 'Sphere' }); context.fill();
    const mask = context.getImageData(0, 0, 512, 512).data;
    const invert = createInverter(projection, definition.inverse);
    let count = 0, failures = 0, recovered = 0;
    for (let y = 4; y < 508; y += 4) for (let x = 4; x < 508; x += 4) {
      const interior = [[x, y], [x - 2, y], [x + 2, y], [x, y - 2], [x, y + 2]]
        .every(([px, py]) => mask[(py * 512 + px) * 4 + 3] === 255);
      if (!interior) continue;
      count++;
      if (!validInverse(projection, x, y)) {
        failures++;
        if (invert(x, y)) recovered++;
      }
    }
    return { count, failures, recovered };
  });
  expect(result.failures).toBeGreaterThan(100);
  expect((result.count - result.failures + result.recovered) / result.count).toBeGreaterThan(0.995);
});

test('Collignon butterfly has valid inverse coverage across all faces', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#select-a')).toBeEnabled();
  await page.selectOption('#select-a', 'collignonButterfly');
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-texture-size', '768');
  await page.screenshot({ path: 'test-results/collignon-butterfly.png' });
  const result = await page.evaluate(async () => {
    const geo = await import('d3-geo');
    const polyhedral = await import('d3-geo-polygon');
    const { canonicalProjection, createInverter } = await import('/projection-engine.js');
    const catalog = await fetch('/projections.json').then(response => response.json());
    const definition = catalog.find(item => item.id === 'collignonButterfly');
    const projection = canonicalProjection(definition, { polyhedral });
    const invert = createInverter(projection, definition.inverse);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 512;
    const context = canvas.getContext('2d');
    context.beginPath(); geo.geoPath(projection, context)({ type: 'Sphere' }); context.fill();
    const mask = context.getImageData(0, 0, 512, 512).data;
    let count = 0, valid = 0;
    const missing = [];
    for (let y = 4; y < 508; y += 4) for (let x = 4; x < 508; x += 4) {
      if (![[x,y], [x-2,y], [x+2,y], [x,y-2], [x,y+2]].every(([px,py]) => mask[(py*512+px)*4+3] === 255)) continue;
      count++;
      if (invert(x,y)) valid++;
      else if (missing.length < 5) missing.push([x,y]);
    }
    return { count, valid, missing };
  });
  expect(result.valid / result.count).toBeGreaterThan(0.995);
});
