import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DIRECTIONS, buildPanels, voxelize } from '../public/src/engine.js';

const colors = [
  { code: 'RED', hex: '#FF0000' },
  { code: 'BLUE', hex: '#0000FF' },
  { code: 'GREEN', hex: '#00FF00' },
  { code: 'WHITE', hex: '#FFFFFF' },
];
const fixtures = new Map();
let textureId = 0;
const previousImage = globalThis.Image;
const previousDocument = globalThis.document;

// A deterministic in-memory image/canvas adapter exercises texture sampling
// without network requests, browsers, native canvases, or game startup.
before(() => {
  globalThis.Image = class {
    set src(value) {
      this.fixture = fixtures.get(value);
      if (!this.fixture) return queueMicrotask(() => this.onerror?.());
      this.width = this.fixture.width;
      this.height = this.fixture.height;
      queueMicrotask(() => this.onload?.());
    }
  };
  globalThis.document = {
    createElement(name) {
      assert.equal(name, 'canvas');
      let current;
      return {
        getContext() {
          return { drawImage(image) { current = image.fixture; }, getImageData() { return { data: current.data }; } };
        },
      };
    },
  };
});
after(() => {
  if (previousImage === undefined) delete globalThis.Image;
  else globalThis.Image = previousImage;
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
});

function texture(width, height, pixels) {
  const id = `memory:engine-test-${textureId++}`;
  fixtures.set(id, { width, height, data: Uint8ClampedArray.from(pixels.flat()) });
  return id;
}
function uniformTexture(rgba) { return texture(1, 1, [rgba]); }
function element(from, to, url) {
  return { from, to, faces: Object.fromEntries(DIRECTIONS.map(d => [d.name, { texture: url, uv: [0, 0, 16, 16] }])) };
}
function box(width, height, depth) {
  const voxels = new Map();
  for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) for (let z = 0; z < depth; z++) {
    const p = [x, y, z];
    voxels.set(p.join(','), { p, colors: Array(6).fill(colors[0]) });
  }
  return voxels;
}
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);

test('16-cube shell assigns every edge/corner bead to exactly one connected planar panel', () => {
  const result = buildPanels(box(16, 16, 16));
  assert.equal(result.panels.length, 6);
  assert.equal(result.surface.length, 16 ** 3 - 14 ** 3);
  assert.equal(new Set(result.surface.map(c => c.p.join(','))).size, result.surface.length);
  assert.equal(result.panels.reduce((sum, p) => sum + p.cells.length, 0), result.surface.length);
  for (const panel of result.panels) {
    const remaining = new Set(panel.cells.map(c => `${c.x},${c.y}`));
    const queue = [panel.cells[0]];
    remaining.delete(`${queue[0].x},${queue[0].y}`);
    while (queue.length) {
      const cell = queue.pop();
      assert.equal(dot(cell.p, panel.normal), panel.plane);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = cell.x + dx, y = cell.y + dy;
        if (remaining.delete(`${x},${y}`)) queue.push({ x, y, p: panel.cells.find(c => c.x === x && c.y === y).p });
      }
    }
    assert.equal(remaining.size, 0, `${panel.id} must form one fused component`);
  }
  for (const x of [0, 15]) for (const y of [0, 15]) for (const z of [0, 15]) {
    assert.equal(result.surface.filter(c => c.p.join(',') === `${x},${y},${z}`).length, 1);
  }
  assert.equal(result.seams.length, 12);
  for (const seam of result.seams) {
    const [a, b] = seam.panels.map(id => result.panels.find(p => p.id === id));
    assert.equal(dot(a.normal, b.normal), 0, 'cube seams join perpendicular faces');
  }
});

test('declared flat sprite keeps all its pixels on a single fabrication face', () => {
  const result = buildPanels(box(16, 16, 1), { flat: true });
  assert.equal(result.panels.length, 1);
  assert.equal(result.panels[0].cells.length, 256);
  assert.deepEqual(result.panels[0].normal, [0, 0, 1]);
});

test('zero-thickness Minecraft face expands to one bead layer, not two boundary layers', async () => {
  const red = uniformTexture([255, 0, 0, 255]);
  const result = await voxelize({ elements: [element([0, 0, 0], [0, 2, 2], red)] }, { id: 'test:plane' }, colors);
  assert.equal(result.voxels.size, 4);
  assert.equal(new Set([...result.voxels.values()].map(v => v.p[0])).size, 1);
});

test('transparent overlay faces preserve the underlying face color', async () => {
  const red = uniformTexture([255, 0, 0, 255]);
  const blue = uniformTexture([0, 0, 255, 255]);
  const clear = uniformTexture([0, 0, 0, 0]);
  const base = element([0, 0, 0], [2, 2, 2], red);
  const overlay = element([0, 0, 0], [2, 2, 2], clear);
  overlay.faces.east.texture = blue;
  const result = await voxelize({ elements: [base, overlay] }, { id: 'test:overlay' }, colors);
  const voxel = result.voxels.get('1,1,1');
  assert.equal(voxel.colors[0]?.code, 'BLUE');
  assert.equal(voxel.colors[1]?.code, 'RED');
  assert.equal(voxel.colors[2]?.code, 'RED');
});

test('front UV uses left-to-right and top-to-bottom texture orientation', async () => {
  const url = texture(2, 2, [[255, 0, 0, 255], [0, 0, 255, 255], [0, 255, 0, 255], [255, 255, 255, 255]]);
  const result = await voxelize({ elements: [element([0, 0, 0], [2, 2, 1], url)] }, { id: 'test:uv' }, colors);
  assert.equal(result.voxels.get('0,1,0').colors[4].code, 'RED');
  assert.equal(result.voxels.get('1,1,0').colors[4].code, 'BLUE');
  assert.equal(result.voxels.get('0,0,0').colors[4].code, 'GREEN');
  assert.equal(result.voxels.get('1,0,0').colors[4].code, 'WHITE');
});

test('parallel touching slabs must not be presented as a perpendicular insertion seam', () => {
  const result = buildPanels(box(2, 2, 2));
  for (const seam of result.seams) {
    const [a, b] = seam.panels.map(id => result.panels.find(p => p.id === id));
    assert.equal(dot(a.normal, b.normal), 0, 'parallel contact needs a different join type or explicit unsupported status');
  }
  assert.ok(result.warnings.length > 0, 'small all-corner solids require a fabrication warning');
});

test('cube slots correspond to perpendicular neighbouring beads without adding material', () => {
  const result = buildPanels(box(16, 16, 16));
  const occupied = new Map(result.surface.map(c => [c.p.join(','), c]));
  assert.ok(result.panels.some(p => p.slots.length > 0));
  assert.equal(result.surface.length, 1352);
  assert.equal(result.palette.reduce((sum, c) => sum + c.count, 0), 1352);
  assert.equal(result.panels.reduce((sum, p) => sum + p.cells.length, 0), 1352);
  for (const panel of result.panels) {
    const original = panel.cells[0];
    const ownCells = new Set(panel.cells.map(c => `${c.x},${c.y}`));
    const uniqueSlots = new Set();
    for (const slot of panel.slots) {
      assert.equal(slot.hole, true);
      assert.ok(slot.x >= 0 && slot.x < panel.width && slot.y >= 0 && slot.y < panel.height);
      const k = `${slot.x},${slot.y}`;
      assert.ok(!ownCells.has(k), 'a slot cannot replace an actual bead');
      assert.ok(!uniqueSlots.has(k), 'each slot is emitted once');
      uniqueSlots.add(k);
      assert.ok([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => ownCells.has(`${slot.x + dx},${slot.y + dy}`)), 'slot must touch a fabrication edge');
      const p = original.p.map((v, i) => v + panel.u[i] * (slot.x - original.x) + panel.v[i] * (slot.y - original.y));
      assert.equal(dot(p, panel.normal), panel.plane);
      const neighbour = occupied.get(p.join(','));
      assert.ok(neighbour, 'slot must be occupied by another assembled panel');
      assert.notEqual(neighbour.panelId, panel.id);
      const other = result.panels.find(other => other.id === neighbour.panelId);
      assert.equal(dot(other.normal, panel.normal), 0);
    }
  }
});

test('transparent interior gaps stay empty and one-bead-wide strips get a strength warning', () => {
  const sheet = box(16, 16, 1);
  sheet.delete('7,7,0');
  const result = buildPanels(sheet, { flat: true });
  assert.equal(result.panels.length, 1);
  assert.equal(result.panels[0].cells.length, 255);
  assert.deepEqual(result.panels[0].slots, []);
  const strip = buildPanels(box(1, 8, 1));
  assert.ok(strip.warnings.some(w => w.includes('一豆宽')));
});
