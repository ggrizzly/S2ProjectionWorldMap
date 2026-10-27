import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as geo from 'd3-geo';
import * as extended from 'd3-geo-projection';
import * as polyhedral from 'd3-geo-polygon';
import { canonicalProjection, createInverter, createProjection, fitView, recommendedRotation, lookupSizes, matchesProjection, validInverse, SPHERE } from '../projection-engine.js';

import { nextZoom, zoomedPan } from '../view-state.js';

test('zoom presets cycle through 100, 200, 400, 800 percent and wrap', () => {
  assert.deepEqual([1, 2, 4, 8].map(nextZoom), [2, 4, 8, 1]);
  assert.equal(nextZoom(1.2), 2);
  assert.equal(nextZoom(0.5), 1);
});

test('zoom keeps the projected point beneath the cursor fixed', () => {
  const pan = [50, -20], center = [400, 300], cursor = [200, 180];
  const updated = zoomedPan(pan, 2, 4, center, cursor);
  for (let axis = 0; axis < 2; axis++) {
    assert.equal((cursor[axis] - center[axis] - pan[axis]) / 2, (cursor[axis] - center[axis] - updated[axis]) / 4);
  }
  assert.deepEqual(zoomedPan(pan, 2, 4, center), [100, -40]);
});

const catalog = JSON.parse(await readFile(new URL('../projections.json', import.meta.url), 'utf8'));
const libraries = { geo, extended, polyhedral };

test('map panning moves texture and vector transforms by exactly the same offset', () => {
  const canonical = canonicalProjection(catalog[0], libraries);
  const bounds = geo.geoPath(canonical).bounds(SPHERE);
  const original = fitView(canonical, bounds, 800, 600, 4);
  const panned = fitView(canonical, bounds, 800, 600, 4, [75, -30]);
  assert.equal(original.scale, panned.scale);
  for (const [axis, delta] of [[0, 75], [1, -30]]) {
    assert.ok(Math.abs(panned.translate[axis] - original.translate[axis] - delta) < 1e-9);
    assert.ok(Math.abs(panned.offset[axis] - original.offset[axis] - delta) < 1e-9);
  }
});

test('ordinary maps start over Africa and polyhedral maps keep native defaults', () => {
  assert.deepEqual(recommendedRotation(catalog.find(item => item.id === 'mercator'), libraries), [-20, 0, 0]);
  for (const definition of catalog.filter(item => item.family === 'Polyhedral')) {
    assert.deepEqual(recommendedRotation(definition, libraries), createProjection(definition, libraries).rotate());
  }
  const custom = { ...catalog[0], defaultRotation: [-30, -10, 20] };
  assert.deepEqual(recommendedRotation(custom, libraries), [-30, -10, 20]);
});

test('polyhedral maps receive finer texture lookups', () => {
  assert.deepEqual(lookupSizes({ family: 'Polyhedral' }), [256, 768]);
  assert.deepEqual(lookupSizes({ family: 'Cylindrical' }), [128, 384]);
});

test('Collignon butterfly repairs the previously empty face', () => {
  const definition = catalog.find(item => item.id === 'collignonButterfly');
  const projection = canonicalProjection(definition, libraries);
  const invert = createInverter(projection, definition.inverse);
  for (const [x, y] of [[132,116], [132,120], [136,120], [140,120], [132,124]]) {
    assert.equal(validInverse(projection, x, y), null);
    const result = invert(x, y);
    assert.ok(result);
    const point = projection(result);
    assert.ok(Math.hypot(point[0] - x, point[1] - y) < 1e-3);
  }
});

test('catalog has at least 60 distinct, fully described projections', () => {
  assert.ok(catalog.length >= 60);
  assert.equal(new Set(catalog.map(item => item.id)).size, catalog.length);
  for (const item of catalog) for (const field of ['id', 'name', 'library', 'constructor', 'family', 'property']) assert.ok(item[field], `${item.id}: missing ${field}`);
});

for (const definition of catalog) {
  test(`${definition.name}: finite geometry and valid inverse samples`, () => {
    const projection = canonicalProjection(definition, libraries);
    const bounds = geo.geoPath(projection).bounds(SPHERE);
    assert.ok(bounds.flat().every(Number.isFinite), 'nonfinite bounds');
    const [[x0, y0], [x1, y1]] = bounds;
    assert.ok(x1 - x0 > 1 && y1 - y0 > 1, 'empty projection');
    assert.ok(x0 >= 3.9 && y0 >= 3.9 && x1 <= 508.1 && y1 <= 508.1, 'outside canonical canvas');
    assert.equal(typeof projection.invert, 'function');
    let hits = 0;
    for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
      if (validInverse(projection, x0 + (x + 0.5) / 12 * (x1 - x0), y0 + (y + 0.5) / 12 * (y1 - y0))) hits++;
    }
    assert.ok(hits > 5, `only ${hits} valid inverse samples`);
  });
}

test('Cahill–Keyes fit preserves translation at every aspect ratio, zoom, and rotation', () => {
  const definition = catalog.find(item => item.id === 'cahillKeyes');
  const canonical = canonicalProjection(definition, libraries);
  assert.deepEqual(canonical.center(), [0, -17]);
  const bounds = geo.geoPath(canonical).bounds(SPHERE);
  for (const [width, height] of [[700, 500], [300, 800], [1400, 240]]) {
    for (const zoom of [0.3, 1, 2]) {
      const fit = fitView(canonical, bounds, width, height, zoom);
      const fitted = createProjection(definition, libraries).rotate([0, 0, 0]).scale(fit.scale).translate(fit.translate);
      const actual = geo.geoPath(fitted).bounds(SPHERE);
      assert.ok(Math.abs((actual[0][0] + actual[1][0]) / 2 - width / 2) < 0.1);
      assert.ok(Math.abs((actual[0][1] + actual[1][1]) / 2 - height / 2) < 0.1);
      for (const rotation of [[0, 0, 0], [30, -52, 15], [-160, 60, -30]]) {
        fitted.rotate(rotation);
        const inverseRotation = geo.geoRotation(rotation).invert;
        for (const point of [[0, 30], [80, -20], [-75, 40]]) {
          const base = canonical(point);
          const dynamic = fitted(inverseRotation(point));
          assert.ok(Math.hypot(dynamic[0] - (base[0] * fit.ratio + fit.offset[0]), dynamic[1] - (base[1] * fit.ratio + fit.offset[1])) < 1e-5);
        }
      }
    }
  }
});

test('Cahill–Keyes recovers invalid native inverse samples', () => {
  const definition = catalog.find(item => item.id === 'cahillKeyes');
  const projection = canonicalProjection(definition, libraries);
  const invert = createInverter(projection, definition.inverse);
  for (const [x, y] of [[116, 160], [120, 160], [124, 160], [120, 164], [124, 164]]) {
    assert.equal(validInverse(projection, x, y), null, 'regression sample must fail native inverse');
    const recovered = invert(x, y);
    assert.ok(recovered, `could not recover ${x},${y}`);
    const forward = projection(recovered);
    assert.ok(Math.hypot(forward[0] - x, forward[1] - y) < 1e-3, 'fallback must land on the original pixel');
    assert.ok(Math.abs(recovered[0]) <= 180 && Math.abs(recovered[1]) <= 90);
  }
});

test('search matches names, aliases, accents, families, and preservation properties', () => {
  const cahill = catalog.find(item => item.id === 'cahillKeyes');
  assert.ok(matchesProjection(cahill, 'cahill-hayes'));
  assert.ok(matchesProjection(cahill, 'CAHILL KEYES'));
  assert.ok(matchesProjection(catalog.find(item => item.id === 'larrivee'), 'larrivee'));
  assert.ok(matchesProjection(catalog.find(item => item.id === 'hoboDyer'), 'cylindrical equal-area'));
  assert.ok(!matchesProjection(cahill, 'no such map'));
});

test('invalid inverse results and out-of-bound pixels are rejected', () => {
  const ortho = canonicalProjection(catalog.find(item => item.id === 'orthographic'), libraries);
  assert.equal(validInverse(ortho, -500, -500), null);
  assert.equal(validInverse({ invert: () => [NaN, 0] }, 0, 0), null);
  assert.equal(validInverse({ invert: () => [0, 100] }, 0, 0), null);
});
