/**
 * MARD palette quantization. All inputs/outputs are sRGB; light mixing is done
 * in linear sRGB. CIEDE2000 uses D65 CIELAB and kL = kC = kH = 1.
 * Formula/reference fixtures: https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/
 * Texture and palette objects are immutable inputs to the bounded caches.
 */
const RAD = Math.PI / 180;
const C25_7 = 25 ** 7;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const srgbLinear = value => {
  const v = clamp(value, 0, 255) / 255;
  return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
};
const rgbKey = rgb => rgb.map(v => Math.round(clamp(v, 0, 255))).join(',');

function linearToLab(v) {
  const xyz = [
    (v[0] * 0.4124564 + v[1] * 0.3575761 + v[2] * 0.1804375) / 0.95047,
    v[0] * 0.2126729 + v[1] * 0.7151522 + v[2] * 0.072175,
    (v[0] * 0.0193339 + v[1] * 0.1191920 + v[2] * 0.9503041) / 1.08883,
  ].map(x => x > 216 / 24389 ? Math.cbrt(x) : (24389 / 27 * x + 16) / 116);
  return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
}

export function rgbToLab(rgb) { return linearToLab(rgb.map(srgbLinear)); }

export function deltaE2000(a, b) {
  const c1 = Math.hypot(a[1], a[2]), c2 = Math.hypot(b[1], b[2]);
  const cMean7 = ((c1 + c2) / 2) ** 7;
  const g = 0.5 * (1 - Math.sqrt(cMean7 / (cMean7 + C25_7)));
  const ap1 = a[1] * (1 + g), ap2 = b[1] * (1 + g);
  const cp1 = Math.hypot(ap1, a[2]), cp2 = Math.hypot(ap2, b[2]);
  const hue = (aa, bb) => (Math.atan2(bb, aa) / RAD + 360) % 360;
  const hp1 = cp1 < 1e-14 ? 0 : hue(ap1, a[2]);
  const hp2 = cp2 < 1e-14 ? 0 : hue(ap2, b[2]);
  const dl = b[0] - a[0], dc = cp2 - cp1;
  let dh = hp2 - hp1;
  if (cp1 * cp2 < 1e-14) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin(dh * RAD / 2);
  const lm = (a[0] + b[0]) / 2, cm = (cp1 + cp2) / 2;
  let hm;
  if (cp1 * cp2 < 1e-14) hm = hp1 + hp2;
  else if (Math.abs(hp1 - hp2) <= 180) hm = (hp1 + hp2) / 2;
  else hm = (hp1 + hp2 + (hp1 + hp2 < 360 ? 360 : -360)) / 2;
  const t = 1 - 0.17 * Math.cos((hm - 30) * RAD)
    + 0.24 * Math.cos(2 * hm * RAD)
    + 0.32 * Math.cos((3 * hm + 6) * RAD)
    - 0.20 * Math.cos((4 * hm - 63) * RAD);
  const sl = 1 + 0.015 * (lm - 50) ** 2 / Math.sqrt(20 + (lm - 50) ** 2);
  const sc = 1 + 0.045 * cm, sh = 1 + 0.015 * cm * t;
  const theta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const rt = -2 * Math.sqrt(cm ** 7 / (cm ** 7 + C25_7)) * Math.sin(2 * theta * RAD);
  const l = dl / sl, c = dc / sc, h = dH / sh;
  return Math.sqrt(Math.max(0, l * l + c * c + h * h + rt * c * h));
}

const deltaE76 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const palettes = new WeakMap();
const textureCache = new WeakMap();
let nextPaletteId = 1;
function paletteData(colors) {
  if (!Array.isArray(colors) || colors.length === 0) throw new TypeError('色卡不能为空');
  let book = palettes.get(colors);
  if (book) return book;
  const values = colors.map((color, index) => {
    if (!/^#[0-9a-f]{6}$/i.test(color.hex)) throw new TypeError('色卡 HEX 格式无效');
    const rgb = color.hex.match(/[0-9a-f]{2}/gi).map(v => parseInt(v, 16));
    return { index, color, rgb, lab: rgbToLab(rgb), linear: rgb.map(srgbLinear) };
  });
  // Keep original indices stable, but never compare an opaque source color
  // with transparent beads: their HEX values are display placeholders only.
  const matchable = values.filter(value => value.color.transparent !== true && value.color.code !== 'H01');
  if (!matchable.length) throw new TypeError('色卡至少需要一种不透明颜色');
  const transparentColor = colors.find(color => color.code === 'H01' && color.transparent === true) || null;
  book = { id: nextPaletteId++, values, matchable, transparentColor,
    matches: new Map(), ranked: new Map(), pairDistances: new Map() };
  palettes.set(colors, book);
  return book;
}
function retain(cache, key, value, limit = 16384) {
  if (cache.size >= limit) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}
function rankedColors(rgb, book, metric) {
  const key = metric + ':' + rgbKey(rgb);
  if (book.ranked.has(key)) return book.ranked.get(key);
  const lab = rgbToLab(rgb);
  const distance = metric === 'legacy' ? deltaE76 : deltaE2000;
  const ranked = book.matchable.map(value => ({ index: value.index, error: distance(lab, value.lab) }))
    .sort((a, b) => a.error - b.error || a.index - b.index);
  // Retain exactly the entries the solid and mixed algorithms can consume:
  // first 14 for mixture search plus first 10 eligible contrast candidates.
  // An eligible candidate beyond rank 14 must remain available, so simply
  // truncating the sorted list would subtly change color decisions.
  const prefix = ranked.slice(0, 14);
  const ids = new Set(prefix.map(c => c.index));
  const extra = ranked.filter(c => eligibleCandidate(lab, c, ranked[0], book))
    .slice(0, 10).filter(c => !ids.has(c.index));
  return retain(book.ranked, key, [...prefix, ...extra], 4096);
}
export function makeMatcher(colors, { metric = 'ciede2000' } = {}) {
  const book = paletteData(colors), mode = metric === 'legacy' || metric === 'cie76' ? 'legacy' : 'accurate';
  return rgb => {
    const key = mode + ':' + rgbKey(rgb);
    if (book.matches.has(key)) return book.matches.get(key);
    return retain(book.matches, key, colors[rankedColors(rgb, book, mode)[0].index]);
  };
}

function hueDifference(a, b) {
  const difference = Math.abs(Math.atan2(a[2], a[1]) - Math.atan2(b[2], b[1])) / RAD;
  return Math.min(difference, 360 - difference);
}
function eligibleCandidate(sourceLab, candidate, nearest, book) {
  if (candidate.error > nearest.error + 5.5) return false;
  const bestHue = hueDifference(sourceLab, book.values[nearest.index].lab);
  const lab = book.values[candidate.index].lab;
  return Math.hypot(sourceLab[1], sourceLab[2]) < 12 || Math.hypot(lab[1], lab[2]) < 8
    || hueDifference(sourceLab, lab) <= Math.max(35, bestHue + 5);
}
function candidatesFor(node, book) {
  if (node.ranked[0].error < 1e-7) return node.ranked.slice(0, 1);
  return node.ranked.filter(candidate => eligibleCandidate(node.lab, candidate, node.ranked[0], book)).slice(0, 10);
}
function paletteDistance(book, a, b) {
  if (a === b) return 0;
  const key = Math.min(a, b) * book.values.length + Math.max(a, b);
  if (!book.pairDistances.has(key)) book.pairDistances.set(key, deltaE2000(book.values[a].lab, book.values[b].lab));
  return book.pairDistances.get(key);
}
function optimizeContrast(nodes, book) {
  const ordered = [...nodes].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  for (let pass = 0; pass < 5; pass++) {
    let changes = 0;
    for (const node of pass % 2 ? [...ordered].reverse() : ordered) {
      let best = node.selected, bestScore = Infinity;
      for (const candidate of node.candidates) {
        let score = node.count * candidate.error ** 2;
        const lab = book.values[candidate.index].lab;
        for (const edge of node.neighbours.values()) {
          // Differences below approximately three ΔE are texture noise, not
          // a reason to introduce stronger, potentially false pixel borders.
          if (edge.sourceDelta < 3) continue;
          const other = book.values[edge.node.selected].lab;
          const originalDL = node.lab[0] - edge.node.lab[0];
          const desiredL = Math.min(24, Math.max(0, Math.abs(originalDL) - 1.5)) * 0.78;
          const actualL = (lab[0] - other[0]) * Math.sign(originalDL);
          const lightLoss = Math.abs(originalDL) >= 3 ? Math.max(0, desiredL - actualL) ** 2 : 0;
          const desiredDelta = Math.min(24, edge.sourceDelta) * 0.72;
          const actualDelta = paletteDistance(book, candidate.index, edge.node.selected);
          const contrastLoss = Math.max(0, desiredDelta - actualDelta) ** 2;
          score += edge.count * 0.8 * (lightLoss + 0.55 * contrastLoss);
        }
        if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) < 1e-9 && candidate.index === node.selected)) {
          bestScore = score;
          best = candidate.index;
        }
      }
      if (best !== node.selected) { node.selected = best; changes++; }
    }
    if (!changes) break;
  }
}

function makeMixture(node, book) {
  const solid = book.values[node.selected];
  const target = node.lab.map((v, i) => v * 0.8 + solid.lab[i] * 0.2);
  const nearestError = node.ranked[0].error;
  if (nearestError < 0.7) return null;
  const pool = [...new Set([node.selected, ...node.ranked.slice(0, 14)
    .filter(c => c.error <= nearestError + 10).map(c => c.index)])].sort((a, b) => a - b);
  let best = null, bestScore = Infinity;
  for (let a = 0; a < pool.length; a++) for (let b = a + 1; b < pool.length; b++) {
    const p = book.values[pool[a]], q = book.values[pool[b]];
    const spread = paletteDistance(book, p.index, q.index);
    if (spread > 21 || Math.abs(p.lab[0] - q.lab[0]) > 22) continue;
    for (let countA = 1; countA <= 3; countA++) {
      const f = countA / 4;
      const linear = p.linear.map((v, i) => v * f + q.linear[i] * (1 - f));
      const lab = linearToLab(linear), error = deltaE2000(node.lab, lab);
      // Mixed tiles must beat the best available single bead by a meaningful
      // margin, not merely undo a contrast-preserving solid-color decision.
      if (error > nearestError - 0.55 || error > nearestError * 0.9) continue;
      const score = 0.8 * error ** 2 + 0.2 * deltaE2000(target, lab) ** 2 + 0.006 * spread ** 2;
      if (score < bestScore) { bestScore = score; best = { a: p.index, b: q.index, countA, lab, error }; }
    }
  }
  return best;
}

/**
 * Quantize one face region. Region is a half-open [x0,y0,x1,y1] rectangle in
 * absolute source-texture pixels. No adjacency or error crosses its boundary.
 * sample() accepts integer texel coordinates and 0/1 coordinates within that
 * texel's 2x2 bead tile. Alpha-zero pixels are null unless fillTransparent is
 * enabled, in which case they return H01. They never participate in matching,
 * adjacency or mixing. Out-of-region samples always return null.
 */
export function createTextureMapper(texture, colors, options = {}) {
  const { tint = [1, 1, 1], mode = 'detail', mix2x2 = false, fillTransparent = false } = options;
  if (!['detail', 'accurate', 'legacy'].includes(mode)) throw new TypeError('未知配色方式：' + mode);
  if (!Number.isInteger(texture.width) || !Number.isInteger(texture.height)
    || texture.width < 1 || texture.height < 1 || texture.data.length < texture.width * texture.height * 4) {
    throw new TypeError('纹理数据无效');
  }
  const book = paletteData(colors), width = texture.width, height = texture.height;
  if (fillTransparent && !book.transparentColor) throw new TypeError('填充透明区域需要标记为透明的 H01 色号');
  const transparentFill = fillTransparent ? book.transparentColor : null;
  const input = options.region || [0, 0, width, height];
  const region = [
    clamp(Math.floor(Math.min(input[0], input[2])), 0, width - 1),
    clamp(Math.floor(Math.min(input[1], input[3])), 0, height - 1),
    clamp(Math.ceil(Math.max(input[0], input[2])), 0, width),
    clamp(Math.ceil(Math.max(input[1], input[3])), 0, height),
  ];
  // Zero-width UV rectangles occur on thin source models; retain the single
  // referenced texel instead of manufacturing a completely empty face.
  region[2] = Math.max(region[0] + 1, region[2]);
  region[3] = Math.max(region[1] + 1, region[3]);
  const factor = tint.map(v => clamp(Number(v), 0, 1));
  const cacheKey = [book.id, mode, Number(mix2x2), Number(fillTransparent), ...factor, ...region].join(':');
  let cached = textureCache.get(texture);
  if (!cached) { cached = new Map(); textureCache.set(texture, cached); }
  if (cached.has(cacheKey)) return cached.get(cacheKey);
  const [x0, y0, x1, y1] = region, stride = x1 - x0;
  const pixels = new Array(stride * (y1 - y0));
  const nodesByColor = new Map();
  let transparentPixels = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = (y * width + x) * 4;
    if (texture.data[p + 3] === 0) { transparentPixels++; continue; }
    const rgb = factor.map((v, i) => texture.data[p + i] * v);
    const key = rgbKey(rgb);
    let node = nodesByColor.get(key);
    if (!node) {
      const ranked = rankedColors(rgb, book, mode);
      node = { key, rgb, lab: rgbToLab(rgb), ranked, selected: ranked[0].index, count: 0, neighbours: new Map() };
      node.candidates = candidatesFor(node, book);
      nodesByColor.set(key, node);
    }
    node.count++;
    pixels[(y - y0) * stride + x - x0] = node;
  }
  let sourceEdges = 0;
  for (let y = 0; y < y1 - y0; y++) for (let x = 0; x < stride; x++) {
    const here = pixels[y * stride + x];
    if (!here) continue;
    for (const there of [x + 1 < stride ? pixels[y * stride + x + 1] : null,
      y + 1 < y1 - y0 ? pixels[(y + 1) * stride + x] : null]) {
      if (!there || there === here) continue;
      sourceEdges++;
      for (const [a, b] of [[here, there], [there, here]]) {
        let edge = a.neighbours.get(b.key);
        if (!edge) { edge = { node: b, count: 0, sourceDelta: deltaE2000(a.lab, b.lab) }; a.neighbours.set(b.key, edge); }
        edge.count++;
      }
    }
  }
  const nodes = [...nodesByColor.values()];
  if (mode === 'detail') optimizeContrast(nodes, book);
  if (mix2x2 && mode !== 'legacy') for (const node of nodes) node.mixture = makeMixture(node, book);
  const used = new Set();
  let pixelsCount = 0, totalError = 0, collapsedEdges = 0, changedMappings = 0, mixedSourceColors = 0;
  for (const node of nodes) {
    if (node.selected !== node.ranked[0].index) changedMappings++;
    pixelsCount += node.count;
    if (node.mixture) { mixedSourceColors++; used.add(node.mixture.a); used.add(node.mixture.b); }
    else used.add(node.selected);
    totalError += node.count * deltaE2000(node.lab, node.mixture?.lab || book.values[node.selected].lab);
    for (const edge of node.neighbours.values()) if (node.selected === edge.node.selected) collapsedEdges += edge.count;
  }
  collapsedEdges /= 2;
  const stats = Object.freeze({ mode, mix2x2: !!mix2x2, fillTransparent: !!fillTransparent,
    region, sourceColors: nodes.length,
    paletteColors: used.size + (transparentFill && transparentPixels ? 1 : 0),
    changedMappings, mixedSourceColors, pixels: pixelsCount, transparentPixels,
    filledTransparentPixels: transparentFill ? transparentPixels : 0,
    sourceEdges, collapsedEdges, boundaryCollapseRate: sourceEdges ? collapsedEdges / sourceEdges : 0,
    // Boundaries are measured for solid assignments so two different mixed
    // tiles are not incorrectly equated solely because a subcell matches.
    boundaryMetric: 'solid-assignments', averageDeltaE2000: pixelsCount ? totalError / pixelsCount : 0 });
  const order = [0, 2, 3, 1];
  const mapper = { stats, sample(x, y, subX = 0, subY = 0) {
    x = Math.floor(x); y = Math.floor(y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < x0 || y < y0 || x >= x1 || y >= y1) return null;
    const node = pixels[(y - y0) * stride + x - x0];
    if (!node) return transparentFill;
    if (!node.mixture) return colors[node.selected];
    const sx = ((Math.floor(subX) % 2) + 2) % 2, sy = ((Math.floor(subY) % 2) + 2) % 2;
    return colors[order[sy * 2 + sx] < node.mixture.countA ? node.mixture.a : node.mixture.b];
  } };
  return retain(cached, cacheKey, mapper, 32);
}
