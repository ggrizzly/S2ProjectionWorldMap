export const ZOOM_LEVELS = [1, 2, 4, 8];

export function nextZoom(current) {
  return ZOOM_LEVELS.find(level => level > current + 1e-6) || ZOOM_LEVELS[0];
}

// Keep the same projected location under the cursor while changing scale.
export function zoomedPan(pan, oldZoom, newZoom, center, anchor = center) {
  const ratio = newZoom / oldZoom;
  return pan.map((value, axis) => anchor[axis] - center[axis] - (anchor[axis] - center[axis] - value) * ratio);
}
