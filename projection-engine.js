// Pure geometry shared by the UI, texture workers, and regression tests.
export const SPHERE = { type: 'Sphere' };
export const CANONICAL_SIZE = 512;

export function createProjection(definition, libraries) {
  const factory = libraries[definition.library]?.[definition.constructor];
  if (typeof factory !== 'function') throw new Error(`Unavailable projection: ${definition.name}`);
  const projection = factory();
  for (const [method, value] of Object.entries(definition.settings || {})) {
    if (typeof projection[method] !== 'function') throw new Error(`Invalid setting: ${method}`);
    projection[method](value);
  }
  return projection;
}

export function recommendedRotation(definition, libraries) {
  if (definition.defaultRotation) return [...definition.defaultRotation];
  const native = createProjection(definition, libraries).rotate();
  // Unfolded maps have their own preferred cuts. Ordinary world maps start over Africa.
  if (definition.family === 'Polyhedral' || definition.family === 'Interrupted' || native.some(value => Math.abs(value) > 1e-8)) return native;
  return [-20, 0, 0];
}

export function lookupSizes(definition) {
  return definition.family === 'Polyhedral' || definition.family === 'Interrupted' ? [256, 768] : [128, 384];
}

export function canonicalProjection(definition, libraries, size = CANONICAL_SIZE) {
  // Keep center, angle, clipping, and the translation computed by fitExtent.
  return createProjection(definition, libraries)
    .rotate([0, 0, 0])
    .fitExtent([[4, 4], [size - 4, size - 4]], SPHERE);
}

export function fitView(canonical, bounds, width, height, zoom = 1, pan = [0, 0]) {
  const [[x0, y0], [x1, y1]] = bounds;
  const ratio = Math.min(Math.max(1, width - 48) / (x1 - x0), Math.max(1, height - 48) / (y1 - y0)) * zoom;
  const offset = [width / 2 - (x0 + x1) / 2 * ratio + pan[0], height / 2 - (y0 + y1) / 2 * ratio + pan[1]];
  return {
    ratio, offset,
    scale: canonical.scale() * ratio,
    translate: canonical.translate().map((value, i) => value * ratio + offset[i]),
  };
}

export function validInverse(projection, x, y, tolerance = 0.75) {
  const point = projection.invert?.([x, y]);
  if (!point || !point.every(Number.isFinite) || Math.abs(point[1]) > 90 || Math.abs(point[0]) > 180 + 1e-5) return null;
  const roundTrip = projection(point);
  if (!roundTrip || Math.hypot(roundTrip[0] - x, roundTrip[1] - y) > tolerance) return null;
  return point;
}

// Some polyhedral inverses converge to the wrong face. Nearby forward
// samples give Newton's method a seed on the correct face of the unfolded map.
export function createInverter(projection, strategy = 'native', tolerance = 0.75) {
  if (strategy !== 'seeded') return (x, y) => validInverse(projection, x, y, tolerance);
  const cellSize = 16;
  const cells = new Map();
  for (let lat = -89; lat < 90; lat += 2) {
    for (let lon = -179; lon < 180; lon += 2) {
      const point = projection([lon, lat]);
      if (!point?.every(Number.isFinite)) continue;
      const key = `${Math.floor(point[0] / cellSize)},${Math.floor(point[1] / cellSize)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push({ point, lon, lat });
    }
  }
  return (x, y) => {
    const native = validInverse(projection, x, y, tolerance);
    if (native) return native;
    const cx = Math.floor(x / cellSize), cy = Math.floor(y / cellSize);
    const candidates = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const sample of cells.get(`${cx + dx},${cy + dy}`) || []) {
        candidates.push({ ...sample, distance: Math.hypot(sample.point[0] - x, sample.point[1] - y) });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    for (const seed of candidates.slice(0, 4)) {
      const result = refineInverse(projection, x, y, seed.lon, seed.lat);
      if (result) return result;
    }
    return null;
  };
}

function refineInverse(projection, x, y, lon, lat) {
  const delta = 1e-4;
  for (let iteration = 0; iteration < 20; iteration++) {
    const point = projection([lon, lat]);
    const ex = point[0] - x, ey = point[1] - y;
    if (Math.hypot(ex, ey) < 1e-4) return [lon, lat];
    const east = projection([lon + delta, lat]);
    const north = projection([lon, lat + delta]);
    const a = (east[0] - point[0]) / delta, b = (north[0] - point[0]) / delta;
    const c = (east[1] - point[1]) / delta, d = (north[1] - point[1]) / delta;
    const determinant = a * d - b * c;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
    const dl = (d * ex - b * ey) / determinant;
    const dp = (a * ey - c * ex) / determinant;
    const damping = Math.min(1, 8 / Math.max(Math.abs(dl), Math.abs(dp)));
    lon = Math.max(-179.999999, Math.min(179.999999, lon - dl * damping));
    lat = Math.max(-89.999999, Math.min(89.999999, lat - dp * damping));
  }
  return null;
}

export function matchesProjection(definition, query) {
  const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[–—-]/g, ' ').toLowerCase();
  const haystack = normalize([definition.name, definition.family, definition.property, ...(definition.aliases || [])].join(' '));
  return normalize(query).trim().split(/\s+/).every(word => haystack.includes(word));
}
