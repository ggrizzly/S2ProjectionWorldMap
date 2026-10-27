import { test, expect } from '@playwright/test';

async function ready(page) {
  await page.goto('/');
  await expect(page.locator('#select-a')).toBeEnabled();
  await expect(page.locator('#globe-stage')).toHaveAttribute('data-rotation', /\[/);
}

async function zoomAll(page, zoom) {
  await page.locator('#globe-stage').press('r');
  for (const level of [2, 4, 8].filter(level => level <= zoom)) {
    await page.locator('#globe-stage').press('z');
    await expect(page.locator('#globe-stage')).toHaveAttribute('data-zoom', String(level));
  }
  // Reset queues a render even when zoom already equals 100%. Wait for that
  // frame before reading orientation; otherwise the previous projection can leak in.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
}

async function dragPixels(page, start, delta, shift = false) {
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(...start);
  await page.mouse.down();
  await page.mouse.move(start[0] + delta[0], start[1] + delta[1], { steps: 4 });
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}

async function trackGlobe(page, zoom, compare = false) {
  await page.getByRole('button', { name: compare ? 'Compare side by side' : 'Explore', exact: true }).click();
  await zoomAll(page, zoom);
  const before = await page.evaluate(async () => {
    const THREE = await import('three');
    const geo = await import('d3-geo');
    const stage = document.getElementById('globe-stage');
    const rect = stage.getBoundingClientRect();
    const start = [Math.round(rect.left + rect.width / 2 + 12), Math.round(rect.top + rect.height / 2 - 8)];
    const rotation = JSON.parse(stage.dataset.rotation);
    const zoom = +stage.dataset.zoom;
    let point;
    if (stage.dataset.renderMode === 'vector') {
      const radius = Math.min(rect.width, rect.height) * 0.42 * zoom;
      const x = (start[0] - rect.left - rect.width / 2) / radius;
      const y = (rect.height / 2 - start[1] + rect.top) / radius;
      point = new THREE.Vector3(x, y, Math.sqrt(1 - x*x - y*y));
    } else {
      const camera = new THREE.PerspectiveCamera(45, rect.width / rect.height, 0.1, 100);
      camera.position.z = 3.1; camera.zoom = zoom;
      camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2((start[0]-rect.left)/rect.width*2-1, 1-(start[1]-rect.top)/rect.height*2), camera);
      point = raycaster.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), 1), new THREE.Vector3());
    }
    const viewed = [Math.atan2(point.x, point.z) * 180 / Math.PI, Math.asin(point.y) * 180 / Math.PI];
    return { start, source: geo.geoRotation(rotation).invert(viewed), rotation: stage.dataset.rotation };
  });
  const delta = [5, 3];
  await dragPixels(page, before.start, delta);
  await expect(page.locator('#globe-stage')).not.toHaveAttribute('data-rotation', before.rotation);
  const actual = await page.evaluate(async source => {
    const geo = await import('d3-geo');
    const stage = document.getElementById('globe-stage');
    const rect = stage.getBoundingClientRect();
    const [lon, lat] = geo.geoRotation(JSON.parse(stage.dataset.rotation))(source).map(value => value * Math.PI / 180);
    const x = Math.cos(lat)*Math.sin(lon), y = Math.sin(lat), z = Math.cos(lat)*Math.cos(lon);
    const scale = stage.dataset.renderMode === 'vector'
      ? Math.min(rect.width,rect.height)*0.42*(+stage.dataset.zoom)
      : rect.height/(2*Math.tan(Math.PI/8))*(+stage.dataset.zoom)/(3.1-z);
    return [rect.left + rect.width/2 + x*scale, rect.top + rect.height/2 - y*scale];
  }, before.source);
  expect(Math.hypot(actual[0] - before.start[0] - delta[0], actual[1] - before.start[1] - delta[1])).toBeLessThan(0.1);
}

test('globe rotation tracks actual cursor pixels at different sizes and zooms', async ({ page }) => {
  await ready(page);
  for (const [zoom, compare] of [[1,false], [8,false], [1,true], [4,true]]) await trackGlobe(page, zoom, compare);
  await page.setViewportSize({ width: 900, height: 700 });
  await trackGlobe(page, 2);
});

test('vector fallback globe also tracks cursor pixels', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      return type.startsWith('webgl') ? null : original.call(this, type, ...args);
    };
  });
  await ready(page);
  await trackGlobe(page, 1);
  await trackGlobe(page, 8, true);
});

test('grabbed map locations follow cursor pixels, including polyhedral and zoomed maps', async ({ page }) => {
  await ready(page);
  for (const [id, zoom] of [['mercator',1], ['naturalEarth',1], ['waterman',1], ['collignonButterfly',1], ['cahillKeyes',1], ['mercator',8], ['naturalEarth',8]]) {
    await page.selectOption('#select-a', id);
    await zoomAll(page, zoom);
    const stage = page.locator('#map-a .map-stage');
    await expect(stage).toHaveAttribute('data-zoom', String(zoom));
    const before = await page.evaluate(async id => {
      const geo = await import('d3-geo');
      const extended = await import('d3-geo-projection');
      const polyhedral = await import('d3-geo-polygon');
      const { canonicalProjection, createProjection, createInverter, fitView, SPHERE } = await import('/projection-engine.js');
      const catalog = await fetch('/projections.json').then(response => response.json());
      const definition = catalog.find(item => item.id === id);
      const libraries = { geo, extended, polyhedral };
      const stage = document.querySelector('#map-a .map-stage');
      const rect = stage.getBoundingClientRect();
      const canonical = canonicalProjection(definition, libraries);
      const fit = fitView(canonical, geo.geoPath(canonical).bounds(SPHERE), rect.width, rect.height, +stage.dataset.zoom);
      const rotation = JSON.parse(document.getElementById('globe-stage').dataset.rotation);
      const projection = createProjection(definition, libraries).rotate(rotation).scale(fit.scale).translate(fit.translate);
      const target = projection([20, +stage.dataset.zoom > 1 ? 0 : 10]);
      const start = [Math.round(rect.left + target[0]), Math.round(rect.top + target[1])];
      const inverse = createInverter(canonical, definition.inverse, 1e-3);
      const viewed = inverse((start[0]-rect.left-fit.offset[0])/fit.ratio, (start[1]-rect.top-fit.offset[1])/fit.ratio);
      return { start, source: geo.geoRotation(rotation).invert(viewed), fit, definition, rotation: JSON.stringify(rotation) };
    }, id);
    const delta = [6, 4];
    await dragPixels(page, before.start, delta, zoom > 1);
    await expect(page.locator('#globe-stage')).not.toHaveAttribute('data-rotation', before.rotation);
    const actual = await page.evaluate(async ({ definition, source, fit }) => {
      const geo = await import('d3-geo');
      const extended = await import('d3-geo-projection');
      const polyhedral = await import('d3-geo-polygon');
      const { createProjection } = await import('/projection-engine.js');
      const rotation = JSON.parse(document.getElementById('globe-stage').dataset.rotation);
      const point = createProjection(definition, { geo, extended, polyhedral }).rotate(rotation).scale(fit.scale).translate(fit.translate)(source);
      const rect = document.querySelector('#map-a .map-stage').getBoundingClientRect();
      return [point[0]+rect.left, point[1]+rect.top];
    }, before);
    expect(Math.hypot(actual[0] - before.start[0] - delta[0], actual[1] - before.start[1] - delta[1]), `${id} at ${zoom*100}%`).toBeLessThan(0.1);
    await expect(stage).toHaveAttribute('data-pan-x', '0');
  }
});

test('dragging empty map space stays gradual and finite', async ({ page }) => {
  await ready(page);
  await page.selectOption('#select-a', 'cahillKeyes');
  await expect(page.locator('#map-a .map-stage')).toHaveAttribute('data-render-mode', /vector|texture/);
  const rect = await page.locator('#map-a .map-stage').boundingBox();
  const before = await page.locator('#globe-stage').getAttribute('data-rotation');
  await dragPixels(page, [rect.x + 10, rect.y + 10], [6, 4]);
  await expect(page.locator('#globe-stage')).not.toHaveAttribute('data-rotation', before);
  const after = JSON.parse(await page.locator('#globe-stage').getAttribute('data-rotation'));
  expect(after.every(Number.isFinite)).toBe(true);
  expect(Math.abs(after[0] - JSON.parse(before)[0])).toBeLessThan(10);
});
