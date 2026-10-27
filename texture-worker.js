import * as geo from 'https://cdn.jsdelivr.net/npm/d3-geo@3.1.1/+esm';
import * as extended from 'https://cdn.jsdelivr.net/npm/d3-geo-projection@4.0.0/+esm';
import * as polyhedral from 'https://cdn.jsdelivr.net/npm/d3-geo-polygon@1.12.1/+esm';
import { canonicalProjection, createInverter, lookupSizes, SPHERE, CANONICAL_SIZE } from './projection-engine.js';

self.onmessage = ({ data: definition }) => {
  try {
    const projection = canonicalProjection(definition, { geo, extended, polyhedral });
    if (!projection.invert) throw new Error('This projection supports vector rendering only.');
    const invert = createInverter(projection, definition.inverse);
    // A quick first pass, then a detailed one. All expensive inversions stay off the UI thread.
    const sizes = lookupSizes(definition);
    for (const size of sizes) {
      const maskCanvas = new OffscreenCanvas(size, size);
      const context = maskCanvas.getContext('2d', { willReadFrequently: true });
      context.scale(size / CANONICAL_SIZE, size / CANONICAL_SIZE);
      context.beginPath();
      geo.geoPath(projection, context)(SPHERE);
      context.fill();
      const mask = context.getImageData(0, 0, size, size).data;
      const pixels = new Float32Array(size * size * 4);
      let valid = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const index = (y * size + x) * 4;
          if (mask[index + 3] < 128) continue;
          const point = invert((x + 0.5) * CANONICAL_SIZE / size, (y + 0.5) * CANONICAL_SIZE / size);
          if (!point) continue;
          const lon = point[0] * Math.PI / 180;
          const lat = point[1] * Math.PI / 180;
          // Cartesian coordinates interpolate correctly across the antimeridian.
          pixels[index] = Math.cos(lat) * Math.cos(lon);
          pixels[index + 1] = Math.cos(lat) * Math.sin(lon);
          pixels[index + 2] = Math.sin(lat);
          pixels[index + 3] = 1;
          valid++;
        }
      }
      if (!valid) throw new Error('No inverse texture samples are available.');
      self.postMessage({ size, pixels: pixels.buffer, final: size === sizes.at(-1) }, [pixels.buffer]);
    }
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
