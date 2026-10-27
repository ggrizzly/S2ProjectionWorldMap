# Sphere: projection atlas

A static globe explorer with 75 map projections. No build step or framework is required.

![Sphere projection explorer preview](assets/preview.gif)

## Run

From this folder, start a local server:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open <http://127.0.0.1:8000>. Direct `file://` access does not support the JSON catalog and module workers.

Internet access is required for the pinned D3/Three.js libraries, world geometry, and Earth image.

## Explore

- Search by projection name, family, or property, such as `butterfly`, `conformal`, or `equal-area`.
- Select a result from the grouped selector. Enter selects the first search result. Escape clears the search.
- Drag the globe to rotate all views. At 100% map zoom, dragging a map also rotates.
- Rotation follows the grabbed surface point, at the current view size and zoom. Empty map space uses viewport-scaled rotation.
- When a map is zoomed in, drag it to pan. Shift-drag rotates instead. Alt-drag always pans.
- Use arrow keys in a focused view. On a zoomed map, arrows pan and Shift-arrows rotate.
- Scroll over a map to zoom at the cursor. Each map has independent zoom and pan controls.
- Select **Compare side by side** for two maps beneath a shared miniature globe.
- Leave **Lock orientation** unchecked to restore recommended orientations after projection changes. Ordinary maps start over Africa.
- Check **Lock orientation** to preserve rotation across projection changes. Manual rotation remains available.
- Select **Reset view** to restore the active projection's orientation and reset all zoom and pan.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| R | Reset orientation, zoom, and pan |
| G | Toggle the graticule on the globe and maps |
| Z | Cycle all views through 100%, 200%, 400%, 800%, then 100% |
| C | Toggle comparison mode |

Shortcuts do not run during text entry or projection selection.

## Projection catalog

`projections.json` is the source for names, search terms, metadata, and projection construction.

```json
{
  "id": "hoboDyer",
  "name": "Hobo–Dyer",
  "library": "extended",
  "constructor": "geoCylindricalEqualArea",
  "family": "Cylindrical",
  "property": "Equal-area",
  "settings": { "parallel": 37.5 }
}
```

Libraries: `geo` is d3-geo, `extended` is d3-geo-projection, and `polyhedral` is d3-geo-polygon.
Optional `aliases` improve search. Optional `description` adds an explanatory note.
Settings call the corresponding D3 methods. New entries need no selector or renderer changes.
The optional `inverse: "seeded"` setting enables a numerical fallback for unreliable native inversions, such as Cahill–Keyes and Collignon butterfly.
The optional `defaultRotation: [longitude, latitude, roll]` field overrides the recommended D3 rotation (in degrees).
Without an override, polyhedral and interrupted maps retain their native recommended rotations.

The projection called “Cahill-Hayes” in the request is **Cahill–Keyes**. Both names work in search.
The AuthaGraph-inspired entry uses Imago. It is not an exact AuthaGraph implementation.

## Rendering

D3 controls the geometry for both the map texture and its outline. The renderer preserves fitted centers and translations.
Cahill–Keyes and Collignon butterfly use forward-seeded numerical inversion to repair incorrect native inverse results.
Textures follow an exact vector clip rather than rectangular lookup cells. Edge interpolation excludes unrelated faces.
Polyhedral and interrupted maps use higher-resolution lookups for clean diagonal edges.
Texture workers create inverse lookups in two passes. A vector preview keeps the app responsive during preparation.
WebGL displays the texture and globe. WebGPU is not required.

Missing images, unavailable workers, or unavailable WebGL leave a usable vector map.
Detailed textures can take longer for complex polyhedral projections. Recent browsers with module-worker and OffscreenCanvas support give the best results.

## Tests

Install the test dependencies and Chromium:

```sh
npm install
npx playwright install chromium
```

Run the canonical test gate:

```sh
./scripts/test.sh
```

The gate checks JavaScript syntax, every catalog entry, geometry alignment, and browser interactions.
Browser tests use the live CDN dependencies and require internet access.
Screenshots appear in `test-results/`.
