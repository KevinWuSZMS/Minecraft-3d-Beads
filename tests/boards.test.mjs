import test from 'node:test';
import assert from 'node:assert/strict';
import { packPanels, boardSVG } from '../public/src/boards.js';

const panel = (id, width, height) => ({ id, name: id, width, height, cells: Array.from({ length: width * height }, (_, i) => ({ x: i % width, y: Math.floor(i / width), code: 'B09', hex: '#2A5037' })) });

test('mixed panels fit without overlap, preserve all cells, and keep a one-peg gutter', () => {
  const panels = [panel('head front', 16, 16), panel('head back', 16, 16), panel('body', 24, 12), panel('leg', 8, 30), panel('arm', 6, 19), panel('wide', 52, 2), panel('thin', 1, 52), panel('full', 52, 52)];
  const boards = packPanels(panels);
  const placements = boards.flatMap(b => b.placements);
  assert.equal(placements.length, panels.length);
  assert.equal(placements.reduce((sum, p) => sum + p.panel.cells.length, 0), panels.reduce((sum, p) => sum + p.cells.length, 0));
  assert.deepEqual(new Set(placements.map(p => p.panel)), new Set(panels));
  for (const board of boards) {
    assert.equal(board.warnings.length, 0);
    for (const a of board.placements) {
      assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.panel.width <= 52 && a.y + a.panel.height <= 52, `bounds ${a.panel.id}`);
      for (const b of board.placements) {
        if (a === b) continue;
        assert.ok(a.x + a.panel.width + 1 <= b.x || b.x + b.panel.width + 1 <= a.x || a.y + a.panel.height + 1 <= b.y || b.y + b.panel.height + 1 <= a.y, `gutter ${a.panel.id} / ${b.panel.id}`);
      }
    }
  }
});

test('oversized panels stay intact on warning-only records, never crop or scale', () => {
  const oversized = panel('dragon wing', 53, 18);
  const boards = packPanels([oversized, panel('valid', 16, 16)]);
  const overflow = boards.find(b => b.unplaced?.includes(oversized));
  assert.ok(overflow);
  assert.equal(overflow.placements.length, 0);
  assert.match(overflow.warnings.join(''), /53 × 18.*52 × 52/);
  assert.strictEqual(overflow.unplaced[0], oversized);
  assert.equal(oversized.cells.length, 53 * 18);
  assert.match(boardSVG(overflow), /未缩放、未裁切/);
});

test('SVG distinguishes reserved slots, renders color codes, and escapes user text', () => {
  const p = { id: 'a"<b', name: '<script>alert(1)</script>', width: 3, height: 2, cells: [{ x: 0, y: 0, code: 'H07', hex: '#010101' }, { x: 1, y: 0, code: 'H01', hex: '#FFFFFF' }, { x: 2, y: 1, hole: true }] };
  const board = packPanels([p])[0];
  const svg = boardSVG(board);
  assert.match(svg, /class="bead-slot"/);
  assert.match(svg, /预留插槽 · 不放豆/);
  assert.match(svg, />H07<|>H01</);
  assert.match(svg, /fill="#FFFFFF" font-family="sans-serif" font-size="6.5"/);
  assert.match(svg, /fill="#14201C" font-family="sans-serif" font-size="6.5"/);
  assert.ok(!svg.includes('<script>'));
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, />52<\/text>/);
  assert.match(svg, /stroke-dasharray="7 5"/);
  const hidden = boardSVG(board, { labels: false, holes: false });
  assert.ok(!hidden.includes('class="bead-slot"'));
  assert.ok(!hidden.includes('font-size="6.5"'));
});

test('invalid coordinates are reported and valid exact-board dimensions are accepted', () => {
  assert.throws(() => packPanels([], 0), RangeError);
  const invalid = { id: 'invalid', width: 2, height: 2, cells: [{ x: 2, y: 0 }] };
  const rejected = packPanels([invalid])[0];
  assert.strictEqual(rejected.unplaced[0], invalid);
  assert.match(rejected.warnings[0], /超出面边界/);
  const exact = packPanels([panel('exact', 52, 52)])[0];
  assert.deepEqual([exact.placements[0].x, exact.placements[0].y], [0, 0]);
  assert.equal(exact.warnings.length, 0);
});

test('separate slot markers render without becoming placed beads', () => {
  const p = { id: 'slotted', width: 2, height: 2, cells: [{ x: 0, y: 0, code: 'H02', hex: '#FBFBFB' }], slots: [{ x: 1, y: 0, hole: true }] };
  const board = packPanels([p])[0];
  const svg = boardSVG(board);
  assert.equal((svg.match(/class="bead-cell"/g) || []).length, 1);
  assert.equal((svg.match(/class="bead-slot"/g) || []).length, 1);
  assert.equal(board.placements[0].panel.cells.length, 1);
  assert.equal((boardSVG(board, { holes: false }).match(/class="bead-slot"/g) || []).length, 0);
});
