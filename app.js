import * as THREE from 'three';
import * as geo from 'd3-geo';
import * as extended from 'd3-geo-projection';
import * as polyhedral from 'd3-geo-polygon';
import { feature } from 'topojson-client';
import { nextZoom, zoomedPan } from './view-state.js';
import { canonicalProjection, createProjection, createInverter, recommendedRotation, fitView, matchesProjection, SPHERE, CANONICAL_SIZE } from './projection-engine.js';

const libraries = { geo, extended, polyhedral };
const response = await fetch('./projections.json');
if (!response.ok) throw new Error(`Projection catalog: HTTP ${response.status}`);
const catalog = await response.json();
for (const definition of catalog) createProjection(definition, libraries);
catalog.sort((a, b) => a.name.localeCompare(b.name));
const definitions = new Map(catalog.map(definition => [definition.id, definition]));
const DEG = Math.PI / 180;
const graticule = geo.geoGraticule10();
let land = null;
let earthTexture = null;
let showGraticule = true;
let globeZoom = 1;
let queued = false;
const views = [];
const lookupCache = new Map();
let activeView = null;
const orientationLock = document.getElementById('orientation-lock');

function queueRender() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    renderGlobe();
    for (const view of views) if (!view.panel.hidden) view.render();
    updateInteractionHint();
  });
}

// Globe orientation is the only state shared by both map views.
const globeStage = document.getElementById('globe-stage');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.z = 3.1;
let globeRenderer;
let globeFallback;
try {
  globeRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  globeRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  globeStage.append(globeRenderer.domElement);
} catch {
  globeFallback = document.createElement('canvas');
  globeStage.append(globeFallback);
}
scene.add(new THREE.AmbientLight(0xffffff, 2));
const light = new THREE.DirectionalLight(0xffffff, 1.5);
light.position.set(4, 3, 5);
scene.add(light);
const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), new THREE.MeshPhongMaterial({ color: 0x568792, shininess: 4 }));
scene.add(sphere);
const gridVertices = [];
for (const line of graticule.coordinates) {
  for (let i = 1; i < line.length; i++) {
    const interpolate = geo.geoInterpolate(line[i - 1], line[i]);
    const steps = Math.max(1, Math.ceil(geo.geoDistance(line[i - 1], line[i]) / (2 * DEG)));
    const points = Array.from({ length: steps + 1 }, (_, step) => {
      const [lon, lat] = interpolate(step / steps).map(value => value * DEG);
      return [Math.cos(lat) * Math.cos(lon) * 1.002, Math.sin(lat) * 1.002, -Math.cos(lat) * Math.sin(lon) * 1.002];
    });
    // Short segments follow the surface; long meridian chords would hide inside the globe.
    for (let j = 1; j < points.length; j++) gridVertices.push(...points[j - 1], ...points[j]);
  }
}
const gridGeometry = new THREE.BufferGeometry();
gridGeometry.setAttribute('position', new THREE.Float32BufferAttribute(gridVertices, 3));
const globeGrid = new THREE.LineSegments(gridGeometry, new THREE.LineBasicMaterial({ color: 0xb2cfd6, transparent: true, opacity: 0.2 }));
sphere.add(globeGrid);

function setRotation(rotation) {
  const transform = geo.geoRotation(rotation);
  const basis = [[0, 0], [0, 90], [-90, 0]].map(point => {
    const [lon, lat] = transform(point).map(value => value * DEG);
    return new THREE.Vector3(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
  });
  sphere.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(...basis));
}
setRotation(recommendedRotation(definitions.get('mercator'), libraries));

function getRotation() {
  const quaternion = sphere.quaternion;
  const localCenter = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion.clone().invert());
  const lon = Math.atan2(-localCenter.z, localCenter.x);
  const lat = Math.asin(THREE.MathUtils.clamp(localCenter.y, -1, 1));
  const north = new THREE.Vector3(-Math.sin(lat) * Math.cos(lon), Math.cos(lat), Math.sin(lat) * Math.sin(lon)).applyQuaternion(quaternion);
  return [-lon / DEG, -lat / DEG, -Math.atan2(north.x, north.y) / DEG];
}

function rotateByAngles(yaw, pitch) {
  const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch);
  sphere.quaternion.premultiply(qy).premultiply(qx).normalize();
  queueRender();
}

function nudgeRotation(dx, dy) {
  // Keyboard nudges have a fixed angular step. Pointer drags use surface picking instead.
  rotateByAngles(dx * 0.4 * DEG, dy * 0.4 * DEG);
}

function rotateBetween(from, to) {
  sphere.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(from, to)).normalize();
  queueRender();
}

function viewVector([longitude, latitude]) {
  const lon = longitude * DEG, lat = latitude * DEG;
  return new THREE.Vector3(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
}

const globeRaycaster = new THREE.Raycaster();
const globeSurface = new THREE.Sphere(new THREE.Vector3(), 1);

function globeDragPoint(clientX, clientY) {
  const rect = globeStage.getBoundingClientRect();
  const x = clientX - rect.left, y = clientY - rect.top;
  if (!globeRenderer) {
    const radius = Math.min(rect.width, rect.height) * 0.42 * globeZoom;
    const sx = (x - rect.width / 2) / radius, sy = (rect.height / 2 - y) / radius;
    return new THREE.Vector3(sx, sy, Math.sqrt(Math.max(0, 1 - sx * sx - sy * sy))).normalize();
  }
  camera.aspect = rect.width / rect.height;
  camera.zoom = globeZoom;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  globeRaycaster.setFromCamera(new THREE.Vector2(x / rect.width * 2 - 1, 1 - y / rect.height * 2), camera);
  const hit = globeRaycaster.ray.intersectSphere(globeSurface, new THREE.Vector3());
  // Continue smoothly at the limb when the pointer leaves the visible disc.
  return hit || globeRaycaster.ray.closestPointToPoint(globeSurface.center, new THREE.Vector3()).normalize();
}

function dragGlobe(dx, dy, event) {
  rotateBetween(globeDragPoint(event.clientX - dx, event.clientY - dy), globeDragPoint(event.clientX, event.clientY));
}

function makeInteractive(element, { zoom, drag = dragGlobe, keyboard = nudgeRotation }) {
  let pointer = null;
  let previous;
  element.addEventListener('pointerdown', event => {
    if (![0, 2].includes(event.button) || pointer !== null) return;
    event.preventDefault();
    pointer = event.pointerId;
    previous = [event.clientX, event.clientY];
    element.setPointerCapture(pointer);
    element.focus({ preventScroll: true });
  });
  element.addEventListener('pointermove', event => {
    if (event.pointerId !== pointer) return;
    drag(event.clientX - previous[0], event.clientY - previous[1], event);
    previous = [event.clientX, event.clientY];
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    element.addEventListener(name, event => { if (event.pointerId === pointer) pointer = null; });
  }
  element.addEventListener('contextmenu', event => event.preventDefault());
  element.addEventListener('wheel', event => {
    event.preventDefault();
    zoom(event.deltaY > 0 ? 0.92 : 1.08, event);
  }, { passive: false });
  element.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const arrows = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] };
    if (arrows[event.key]) {
      event.preventDefault();
      keyboard(...arrows[event.key], event);
    } else if (event.key === '+' || event.key === '=' || event.key === '-') {
      event.preventDefault();
      zoom(event.key === '-' ? 1 / 1.1 : 1.1);
    }
  });
}
function setGlobeZoom(value) {
  globeZoom = THREE.MathUtils.clamp(value, 0.3, 8);
  queueRender();
}
makeInteractive(globeStage, { zoom: factor => setGlobeZoom(globeZoom * factor) });

function renderGlobe() {
  globeGrid.visible = showGraticule;
  globeStage.dataset.graticule = String(showGraticule);
  const { width, height } = globeStage.getBoundingClientRect();
  if (width < 1 || height < 1) return;
  if (globeRenderer) {
    const size = globeRenderer.getSize(new THREE.Vector2());
    if (size.x !== width || size.y !== height) globeRenderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.zoom = globeZoom;
    camera.updateProjectionMatrix();
    globeRenderer.render(scene, camera);
  } else {
    globeFallback.width = width;
    globeFallback.height = height;
    const context = globeFallback.getContext('2d');
    const projection = geo.geoOrthographic().rotate(getRotation()).scale(Math.min(width, height) * 0.42 * globeZoom).translate([width / 2, height / 2]);
    drawVectors(context, projection, true);
  }
  globeStage.dataset.zoom = String(globeZoom);
  document.getElementById('cycle-zoom').textContent = `${Math.round(globeZoom * 100)}%`;
  const rotation = getRotation();
  globeStage.dataset.rotation = JSON.stringify(rotation);
  globeStage.dataset.renderMode = globeRenderer ? 'webgl' : 'vector';
  const [lon, lat] = rotation.map(value => Math.abs(value) < 1e-8 ? 0 : -value);
  document.getElementById('coordinates').textContent = `${Math.abs(lon).toFixed(1)}° ${lon < 0 ? 'W' : 'E'} · ${Math.abs(lat).toFixed(1)}° ${lat < 0 ? 'S' : 'N'}`;
}

function drawVectors(context, projection, fill) {
  const path = geo.geoPath(projection, context);
  if (fill) {
    context.beginPath(); path(SPHERE);
    context.fillStyle = '#132b40'; context.fill();
    if (land) {
      context.beginPath(); path(land);
      context.fillStyle = '#718c78'; context.fill();
    }
  }
  if (showGraticule) {
    context.beginPath(); path(graticule);
    context.strokeStyle = 'rgba(178,207,214,0.23)'; context.lineWidth = 0.6; context.stroke();
  }
  context.beginPath(); path(SPHERE);
  context.strokeStyle = '#637f8c'; context.lineWidth = 0.8; context.stroke();
}

const vertexShader = `
  varying vec2 screenUV;
  void main() { screenUV = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const fragmentShader = `
  precision highp float;
  uniform sampler2D lookup;
  uniform sampler2D earth;
  uniform float lookupSize;
  uniform vec2 viewSize;
  uniform vec2 offset;
  uniform float ratio;
  uniform mat3 rotation;
  varying vec2 screenUV;
  const float PI = 3.141592653589793;
  vec4 sampleLookup(vec2 index) {
    return texture2D(lookup, (clamp(index, vec2(0.0), vec2(lookupSize - 1.0)) + 0.5) / lookupSize);
  }
  void main() {
    vec2 pixel = vec2(screenUV.x, 1.0 - screenUV.y) * viewSize;
    vec2 uv = (pixel - offset) / ratio / ${CANONICAL_SIZE.toFixed(1)};
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) discard;
    vec2 grid = uv * lookupSize - 0.5;
    vec2 base = floor(grid);
    vec2 f = fract(grid);
    vec4 a = sampleLookup(base);
    vec4 b = sampleLookup(base + vec2(1.0, 0.0));
    vec4 c = sampleLookup(base + vec2(0.0, 1.0));
    vec4 d = sampleLookup(base + vec2(1.0, 1.0));
    vec4 weights = vec4((1.0-f.x)*(1.0-f.y), f.x*(1.0-f.y), (1.0-f.x)*f.y, f.x*f.y);
    vec4 point = sampleLookup(floor(uv * lookupSize));
    // Extend valid edge samples to the exact vector clip, not rectangular LUT cells.
    if (point.w < 0.5) {
      float best = -1.0;
      if (a.w > 0.5 && weights.x > best) { point = a; best = weights.x; }
      if (b.w > 0.5 && weights.y > best) { point = b; best = weights.y; }
      if (c.w > 0.5 && weights.z > best) { point = c; best = weights.z; }
      if (d.w > 0.5 && weights.w > best) { point = d; }
    }
    if (point.w < 0.5) discard;
    // Use only nearby directions on this face; never blend unrelated faces across a cut.
    weights *= vec4(a.w * step(0.9, dot(point.xyz,a.xyz)), b.w * step(0.9, dot(point.xyz,b.xyz)), c.w * step(0.9, dot(point.xyz,c.xyz)), d.w * step(0.9, dot(point.xyz,d.xyz)));
    float total = dot(weights, vec4(1.0));
    if (total > 0.00001) point = (a*weights.x + b*weights.y + c*weights.z + d*weights.w) / total;
    vec3 position = normalize(rotation * normalize(point.xyz));
    float lon = atan(position.y, position.x);
    float lat = asin(clamp(position.z, -1.0, 1.0));
    gl_FragColor = texture2D(earth, vec2((lon + PI) / (2.0 * PI), (lat + PI / 2.0) / PI));
    #include <colorspace_fragment>
  }
`;

function inverseRotationMatrix(rotation) {
  // Let D3 define the convention, including roll, instead of maintaining separate math.
  const inverse = geo.geoRotation(rotation).invert;
  const columns = [[0, 0], [90, 0], [0, 90]].map(point => {
    const [lon, lat] = inverse(point).map(value => value * DEG);
    return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  });
  return new THREE.Matrix3().set(
    columns[0][0], columns[1][0], columns[2][0],
    columns[0][1], columns[1][1], columns[2][1],
    columns[0][2], columns[1][2], columns[2][2],
  );
}

// Editable combobox: results float over the map, and focus stays in the input.
class ProjectionPicker {
  constructor(panel, onChange) {
    this.root = panel.querySelector('.projection-picker');
    this.details = panel.querySelector('.projection-details');
    this.details.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); this.details.open = false; }
    });
    this.input = this.root.querySelector('input');
    this.popup = this.root.querySelector('.projection-popup');
    this.list = this.root.querySelector('[role="listbox"]');
    this.clear = this.root.querySelector('.clear-search');
    this.toggle = this.root.querySelector('.toggle-projections');
    this.onChange = onChange;
    this.isOpen = false;
    this.options = [];
    this.input.addEventListener('focus', () => this.open());
    this.input.addEventListener('click', () => this.open());
    this.input.addEventListener('input', () => {
      if (!this.isOpen) this.open(false);
      else this.render(this.input.value);
    });
    this.input.addEventListener('keydown', event => this.keydown(event));
    this.root.addEventListener('mousedown', event => {
      if (event.target.closest('button, [role="option"]')) event.preventDefault();
    });
    this.root.addEventListener('focusout', event => {
      if (!this.root.contains(event.relatedTarget)) this.close();
    });
    this.toggle.addEventListener('click', () => {
      if (this.isOpen) this.close();
      else { this.open(); this.input.focus(); }
    });
    this.clear.addEventListener('click', () => {
      this.input.value = '';
      this.render('');
      this.input.focus();
    });
    this.list.addEventListener('click', event => {
      const option = event.target.closest('[role="option"]');
      if (option) this.onChange(option.dataset.value);
    });
    document.addEventListener('pointerdown', event => {
      if (this.isOpen && !this.root.contains(event.target)) this.close();
      if (!this.details.contains(event.target)) this.details.open = false;
    });
    const reposition = () => { if (this.isOpen) this.position(); };
    window.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('resize', reposition);
  }

  setSelection(definition) {
    this.definition = definition;
    this.input.disabled = this.toggle.disabled = false;
    this.input.title = definition.name;
    this.input.placeholder = definition.name;
    this.close();
  }

  position() {
    const bounds = this.root.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop || 0;
    const bottom = top + (viewport?.height || innerHeight);
    const above = bounds.top - top, below = bottom - bounds.bottom;
    const upwards = below < 200 && above > below;
    this.root.dataset.side = upwards ? 'above' : 'below';
    this.root.style.setProperty('--picker-space', `${Math.max(100, (upwards ? above : below) - 12)}px`);
  }

  open(clear = true) {
    if (this.isOpen || this.input.disabled) return;
    this.isOpen = true;
    this.details.open = false;
    if (clear) this.input.value = '';
    this.popup.hidden = false;
    this.input.placeholder = 'Search projections…';
    this.input.setAttribute('aria-expanded', 'true');
    this.toggle.setAttribute('aria-expanded', 'true');
    this.position();
    this.render(this.input.value);
  }

  close() {
    this.isOpen = false;
    this.popup.hidden = true;
    this.input.value = this.definition?.name || '';
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    this.toggle.setAttribute('aria-expanded', 'false');
    this.clear.hidden = true;
  }

  render(query) {
    const matching = catalog.filter(definition => matchesProjection(definition, query));
    this.list.replaceChildren();
    for (const family of [...new Set(matching.map(item => item.family))].sort()) {
      const group = document.createElement('div');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', family);
      const heading = document.createElement('div');
      heading.className = 'projection-group';
      heading.textContent = family;
      heading.setAttribute('aria-hidden', 'true');
      group.append(heading);
      for (const definition of matching.filter(item => item.family === family)) {
        const option = document.createElement('div');
        option.id = `${this.list.id}-${definition.id}`;
        option.dataset.value = definition.id;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(definition.id === this.definition.id));
        const name = document.createElement('span');
        name.textContent = definition.name;
        const property = document.createElement('span');
        property.className = 'option-property';
        property.textContent = definition.property;
        option.append(name, property);
        group.append(option);
      }
      this.list.append(group);
    }
    this.options = [...this.list.querySelectorAll('[role="option"]')];
    this.root.querySelector('.projection-empty').hidden = matching.length > 0;
    this.root.querySelector('.catalog-count').textContent = query ? `${matching.length} / ${catalog.length} found` : `${catalog.length} projections`;
    this.clear.hidden = !query;
    const current = query ? 0 : this.options.findIndex(option => option.dataset.value === this.definition.id);
    this.highlight(Math.max(0, current));
  }

  highlight(index) {
    this.active = index;
    this.options.forEach((option, i) => { option.dataset.active = String(i === index); });
    const option = this.options[index];
    if (option) {
      this.input.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    } else this.input.removeAttribute('aria-activedescendant');
  }

  keydown(event) {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape' && this.isOpen) {
      event.preventDefault();
      this.close();
    } else if (event.key === 'Tab') this.close();
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!this.isOpen) this.open();
      else if (this.options.length) this.highlight((this.active + (event.key === 'ArrowDown' ? 1 : -1) + this.options.length) % this.options.length);
    } else if (this.isOpen && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault();
      this.highlight(event.key === 'Home' ? 0 : this.options.length - 1);
    } else if (event.key === 'Enter' && this.isOpen) {
      event.preventDefault();
      if (this.options[this.active]) this.onChange(this.options[this.active].dataset.value);
    }
  }
}

class MapView {
  constructor(id, initial) {
    this.panel = document.getElementById(id);
    this.stage = this.panel.querySelector('.map-stage');
    this.overlay = this.panel.querySelector('.map-overlay');
    this.context = this.overlay.getContext('2d');
    this.picker = new ProjectionPicker(this.panel, id => this.setProjection(id));
    this.status = this.panel.querySelector('.map-status');
    this.zoom = 1;
    this.pan = [0, 0];
    this.worker = null;
    this.workerTimer = null;
    this.lookup = null;
    try {
      this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      this.renderer.domElement.className = 'map-texture';
      this.stage.prepend(this.renderer.domElement);
      this.scene = new THREE.Scene();
      this.camera = new THREE.Camera();
      this.material = new THREE.ShaderMaterial({
        vertexShader, fragmentShader,
        uniforms: {
          lookup: { value: null }, earth: { value: null }, lookupSize: { value: 128 },
          viewSize: { value: new THREE.Vector2() }, offset: { value: new THREE.Vector2() },
          ratio: { value: 1 }, rotation: { value: new THREE.Matrix3() },
        },
        depthTest: false, depthWrite: false,
      });
      this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
    } catch {
      this.renderer = null;
    }
    this.panel.addEventListener('focusin', () => { activeView = this; });
    makeInteractive(this.stage, {
      zoom: (factor, event) => {
        activeView = this;
        const rect = this.stage.getBoundingClientRect();
        const anchor = event ? [event.clientX - rect.left, event.clientY - rect.top] : undefined;
        this.setZoom(this.zoom * factor, anchor);
      },
      drag: (dx, dy, event) => {
        activeView = this;
        if (!event.shiftKey && (this.zoom > 1 || event.altKey || event.buttons === 2)) this.panBy(dx, dy);
        else this.rotateAtPointer(dx, dy, event);
      },
      keyboard: (dx, dy, event) => {
        if (this.zoom > 1 && !event.shiftKey) this.panBy(dx * 3, dy * 3);
        else nudgeRotation(dx, dy);
      },
    });
    for (const button of this.panel.querySelectorAll('[data-zoom]')) {
      button.addEventListener('click', () => {
        if (button.dataset.zoom === 'reset') this.resetViewport();
        else this.setZoom(this.zoom * (button.dataset.zoom === 'in' ? 1.2 : 1 / 1.2));
      });
    }
    this.setProjection(initial, false);
  }

  setProjection(id, load = true) {
    const definition = definitions.get(id);
    if (!definition) return;
    this.stopWorker();
    this.definition = definition;
    if (load) {
      activeView = this;
      if (!orientationLock.checked) setRotation(recommendedRotation(definition, libraries));
    }
    this.zoom = 1;
    this.pan = [0, 0];
    this.lookup = lookupCache.get(id) || null;
    this.canonical = canonicalProjection(definition, libraries);
    this.bounds = geo.geoPath(this.canonical).bounds(SPHERE);
    this.dragInverter = null;
    this.pickContext ||= document.createElement('canvas').getContext('2d');
    this.pickOutline = new Path2D(geo.geoPath(this.canonical)(SPHERE));
    this.picker.setSelection(definition);
    this.panel.querySelector('.family').textContent = definition.family;
    this.panel.querySelector('.property').textContent = definition.property;
    const description = this.panel.querySelector('.projection-description');
    const details = this.panel.querySelector('.projection-details');
    details.hidden = !definition.description;
    details.open = false;
    description.textContent = definition.description || '';
    this.stage.dataset.projection = id;
    this.stage.dataset.renderMode = 'pending';
    this.stage.dataset.textureSize = String(this.lookup?.size || 0);
    this.status.textContent = '';
    if (load && !this.panel.hidden) this.ensureLookup();
    queueRender();
  }

  stopWorker() {
    this.worker?.terminate();
    this.worker = null;
    clearTimeout(this.workerTimer);
  }

  ensureLookup() {
    if (!this.renderer || this.lookup?.final || this.worker) return;
    this.status.textContent = this.lookup ? 'Refining Earth texture…' : 'Vector preview · Preparing Earth texture…';
    try {
      const worker = new Worker(new URL('./texture-worker.js', import.meta.url), { type: 'module' });
      this.worker = worker;
      const failed = message => {
        this.stopWorker();
        this.status.textContent = this.lookup ? '' : message;
        queueRender();
      };
      this.workerTimer = setTimeout(() => failed('Vector view · Texture preparation timed out. Reselect to retry.'), 90_000);
      worker.onerror = () => failed('Vector view · Texture worker unavailable.');
      worker.onmessage = ({ data }) => {
        if (this.worker !== worker) return;
        if (data.error) { failed('Vector view · Texture unavailable for this projection.'); return; }
        const previous = lookupCache.get(this.definition.id);
        if (previous?.size > data.size) return; // Another view already finished a finer lookup.
        const texture = new THREE.DataTexture(new Float32Array(data.pixels), data.size, data.size, THREE.RGBAFormat, THREE.FloatType);
        texture.minFilter = texture.magFilter = THREE.NearestFilter;
        texture.needsUpdate = true;
        this.lookup = { texture, size: data.size, final: data.final };
        lookupCache.delete(this.definition.id);
        lookupCache.set(this.definition.id, this.lookup);
        // A second view can share a cached lookup; update it before disposing the old one.
        for (const view of views) {
          if (view.definition.id !== this.definition.id) continue;
          view.lookup = this.lookup;
          view.stage.dataset.textureSize = String(data.size);
          view.status.textContent = data.final ? '' : 'Refining Earth texture…';
        }
        previous?.texture.dispose();
        for (const [key, entry] of lookupCache) {
          if (lookupCache.size <= 8) break;
          if (!views.some(view => view.definition.id === key)) { entry.texture.dispose(); lookupCache.delete(key); }
        }
        if (data.final) this.stopWorker();
        queueRender();
      };
      worker.postMessage(this.definition);
    } catch {
      this.status.textContent = 'Vector view · Texture worker unavailable.';
    }
  }

  setZoom(value, anchor) {
    const zoom = THREE.MathUtils.clamp(value, 0.3, 8);
    const { width, height } = this.stage.getBoundingClientRect();
    this.pan = zoom <= 1 ? [0, 0] : zoomedPan(this.pan, this.zoom, zoom, [width / 2, height / 2], anchor);
    this.zoom = zoom;
    queueRender();
  }

  pickDirection(clientX, clientY) {
    const rect = this.stage.getBoundingClientRect();
    const fit = fitView(this.canonical, this.bounds, rect.width, rect.height, this.zoom, this.pan);
    const x = (clientX - rect.left - fit.offset[0]) / fit.ratio;
    const y = (clientY - rect.top - fit.offset[1]) / fit.ratio;
    if (!this.pickContext.isPointInPath(this.pickOutline, x, y)) return null;
    // This is one pointer sample, not per-pixel raster work. Cache the seeded inverter.
    this.dragInverter ||= createInverter(this.canonical, this.definition.inverse, 1e-3);
    const point = this.dragInverter(x, y);
    return point ? viewVector(point) : null;
  }

  rotateAtPointer(dx, dy, event) {
    const from = this.pickDirection(event.clientX - dx, event.clientY - dy);
    const to = this.pickDirection(event.clientX, event.clientY);
    if (from && to && from.dot(to) > 0.5) {
      rotateBetween(from, to);
      return;
    }
    // Empty space and disconnected cuts have no grabbed surface. Use the fitted
    // map's pixel extent here, never a fixed sensitivity or a jump to another face.
    const rect = this.stage.getBoundingClientRect();
    const fit = fitView(this.canonical, this.bounds, rect.width, rect.height, this.zoom, this.pan);
    const mapWidth = (this.bounds[1][0] - this.bounds[0][0]) * fit.ratio;
    const mapHeight = (this.bounds[1][1] - this.bounds[0][1]) * fit.ratio;
    rotateByAngles(dx * Math.PI * 2 / mapWidth, dy * Math.PI / mapHeight);
  }

  panBy(dx, dy) {
    this.pan[0] += dx;
    this.pan[1] += dy;
    queueRender();
  }

  resetViewport() {
    this.zoom = 1;
    this.pan = [0, 0];
    queueRender();
  }

  render() {
    const { width, height } = this.stage.getBoundingClientRect();
    if (width < 1 || height < 1) return;
    const fit = fitView(this.canonical, this.bounds, width, height, this.zoom, this.pan);
    const projection = createProjection(this.definition, libraries).rotate(getRotation()).scale(fit.scale).translate(fit.translate);
    const pixelRatio = Math.min(devicePixelRatio, 2);
    const w = Math.round(width * pixelRatio), h = Math.round(height * pixelRatio);
    if (this.overlay.width !== w || this.overlay.height !== h) { this.overlay.width = w; this.overlay.height = h; }
    this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    this.context.clearRect(0, 0, width, height);
    const textured = Boolean(this.renderer && this.lookup && earthTexture);
    if (this.renderer) {
      this.renderer.domElement.hidden = !textured;
      if (textured) {
        const size = this.renderer.getSize(new THREE.Vector2());
        if (size.x !== width || size.y !== height) this.renderer.setSize(width, height, false);
        // CSS clips in viewport pixels, so the silhouette stays sharp at every zoom/DPR.
        const outline = geo.geoPath(projection)(SPHERE);
        this.renderer.domElement.style.clipPath = outline ? `path('${outline}')` : 'none';
        const uniforms = this.material.uniforms;
        uniforms.lookup.value = this.lookup.texture;
        uniforms.lookupSize.value = this.lookup.size;
        uniforms.earth.value = earthTexture;
        uniforms.viewSize.value.set(width, height);
        uniforms.offset.value.set(...fit.offset);
        uniforms.ratio.value = fit.ratio;
        uniforms.rotation.value.copy(inverseRotationMatrix(getRotation()));
        this.renderer.render(this.scene, this.camera);
      }
    }
    drawVectors(this.context, projection, !textured);
    this.stage.dataset.renderMode = textured ? 'texture' : 'vector';
    this.stage.dataset.zoom = String(this.zoom);
    this.stage.dataset.panX = String(this.pan[0]);
    this.stage.dataset.panY = String(this.pan[1]);
    this.stage.dataset.interaction = this.zoom > 1 ? 'pan' : 'rotate';
    this.panel.querySelector('.render-mode').textContent = textured ? 'EARTH TEXTURE' : 'VECTOR PREVIEW';
    this.panel.querySelector('[data-zoom="reset"]').textContent = `${Math.round(this.zoom * 100)}%`;
  }
}

views.push(new MapView('map-a', 'mercator'), new MapView('map-b', 'waterman'));
activeView = views[0];
views[0].ensureLookup();
orientationLock.addEventListener('change', () => {
  if (!orientationLock.checked) setRotation(recommendedRotation(activeView.definition, libraries));
  queueRender();
});

function setMode(compare) {
  document.getElementById('workspace').classList.toggle('comparing', compare);
  document.getElementById('map-b').hidden = !compare;
  document.getElementById('single-mode').setAttribute('aria-pressed', String(!compare));
  document.getElementById('compare-mode').setAttribute('aria-pressed', String(compare));
  document.querySelector('.slot-label').textContent = compare ? 'Projection A' : 'The projection';
  if (!compare && activeView === views[1]) activeView = views[0];
  if (compare) views[1].ensureLookup();
  else views[1].stopWorker();
  queueRender();
}
document.getElementById('compare-mode').addEventListener('click', () => setMode(true));
document.getElementById('single-mode').addEventListener('click', () => setMode(false));
function resetView() {
  setRotation(recommendedRotation(activeView.definition, libraries));
  setGlobeZoom(1);
  for (const view of views) view.resetViewport();
}

function cycleZoom() {
  const current = document.activeElement === globeStage ? globeZoom : activeView.zoom;
  const zoom = nextZoom(current);
  setGlobeZoom(zoom);
  for (const view of views) view.setZoom(zoom);
}

function setGraticule(visible) {
  showGraticule = visible;
  document.getElementById('graticule-toggle').checked = visible;
  queueRender();
}

function updateInteractionHint() {
  if (!activeView) return;
  document.getElementById('interaction-hint').textContent = activeView.zoom > 1
    ? 'Drag map to pan · Shift-drag to rotate · Scroll at cursor to zoom'
    : 'Drag to rotate · Alt-drag to pan · Scroll at cursor to zoom';
}

document.getElementById('reset-view').addEventListener('click', resetView);
document.getElementById('cycle-zoom').addEventListener('click', cycleZoom);
document.getElementById('graticule-toggle').addEventListener('change', event => setGraticule(event.target.checked));
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.isContentEditable || event.target.closest('textarea, select, input:not([type="checkbox"]):not([type="radio"])')) return;
  const actions = {
    r: resetView,
    g: () => setGraticule(!showGraticule),
    z: cycleZoom,
    c: () => setMode(document.getElementById('map-b').hidden),
  };
  const action = actions[event.key.toLowerCase()];
  if (action) { event.preventDefault(); action(); }
});
const resizeObserver = new ResizeObserver(queueRender);
resizeObserver.observe(globeStage);
for (const view of views) resizeObserver.observe(view.stage);

// Geography and imagery load independently: interaction never waits for either.
fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json')
  .then(response => { if (!response.ok) throw new Error('Land unavailable'); return response.json(); })
  .then(topology => { land = feature(topology, topology.objects.land); queueRender(); })
  .catch(() => {
    for (const view of views) if (!earthTexture) view.status.textContent = 'Geography unavailable · Check your connection.';
  });

const textureLoader = new THREE.TextureLoader();
function applyEarth(texture) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  earthTexture = texture;
  sphere.material.map = texture;
  sphere.material.color.set(0xffffff);
  sphere.material.needsUpdate = true;
  for (const view of views) if (view.lookup) view.status.textContent = '';
  queueRender();
}
textureLoader.load('https://unpkg.com/three-globe@2.34.1/example/img/earth-blue-marble.jpg', applyEarth, undefined, () => {
  textureLoader.load('https://threejs.org/examples/textures/land_ocean_ice_cloud_2048.jpg', applyEarth, undefined, () => {
    for (const view of views) view.status.textContent = 'Vector view · Earth image unavailable.';
    queueRender();
  });
});

window.addEventListener('pagehide', () => {
  for (const view of views) view.stopWorker();
});
queueRender();
