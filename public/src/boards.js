/**
 * Pack intact bead panels into fixed-size boards. Coordinates are zero-based pegs.
 * The returned array can contain warning-only boards with `unplaced` panels.
 * Such panels are deliberately not resized, cropped, or dropped.
 */
export function packPanels(panels, size = 52) {
  if (!Number.isInteger(size) || size < 1 || size > 256) {
    throw new RangeError('豆板尺寸必须是 1–256 的整数');
  }
  if (!Array.isArray(panels)) throw new TypeError('panels 必须是数组');

  const boards = [];
  const rejected = [];
  const candidates = panels.map((panel, order) => ({ panel, order })).filter(({ panel, order }) => {
    const issue = panelIssue(panel, size);
    if (!issue) return true;
    rejected.push({ panel, order, issue });
    return false;
  });
  candidates.sort((a, b) =>
    Math.max(b.panel.width, b.panel.height) - Math.max(a.panel.width, a.panel.height)
    || b.panel.width * b.panel.height - a.panel.width * a.panel.height
    || a.order - b.order);

  const freeByBoard = new Map();
  for (const { panel, order } of candidates) {
    // A one-peg row above each panel holds its number and upright arrow.
    // A full-height panel keeps all 52 rows and uses the outside legend instead.
    const header = panel.height < size ? 1 : 0;
    const occupiedWidth = Math.min(size, Math.max(panel.width, 3)) + 1;
    const occupiedHeight = panel.height + header + 1;
    let best;
    for (const board of boards) {
      for (const [slot, free] of freeByBoard.get(board).entries()) {
        if (occupiedWidth > free.width || occupiedHeight > free.height) continue;
        const score = free.width * free.height - occupiedWidth * occupiedHeight;
        if (!best || score < best.score) best = { board, slot, free, score };
      }
    }
    if (!best) {
      const board = { size, placements: [], index: boards.length + 1, warnings: [] };
      boards.push(board);
      const free = { x: 0, y: 0, width: size + 1, height: size + 1 };
      freeByBoard.set(board, [free]);
      best = { board, slot: 0, free, score: 0 };
    }
    const { board, slot, free } = best;
    board.placements.push({ panel, x: free.x, y: free.y + header, number: order + 1, labelRow: header === 1 });
    const spaces = freeByBoard.get(board);
    spaces.splice(slot, 1);
    const dw = free.width - occupiedWidth;
    const dh = free.height - occupiedHeight;
    // Non-overlapping guillotine partitions keep an exact one-peg gutter.
    if (dw > dh) {
      if (dw > 0) spaces.push({ x: free.x + occupiedWidth, y: free.y, width: dw, height: free.height });
      if (dh > 0) spaces.push({ x: free.x, y: free.y + occupiedHeight, width: occupiedWidth, height: dh });
    } else {
      if (dw > 0) spaces.push({ x: free.x + occupiedWidth, y: free.y, width: dw, height: occupiedHeight });
      if (dh > 0) spaces.push({ x: free.x, y: free.y + occupiedHeight, width: free.width, height: dh });
    }
  }
  for (const { panel, order, issue } of rejected) {
    boards.push({ size, placements: [], index: boards.length + 1, warnings: [`面 ${order + 1}「${panel?.name || panel?.id || '未命名'}」：${issue}`], unplaced: [panel] });
  }
  return boards;
}

function panelIssue(panel, size) {
  if (!panel || !Number.isInteger(panel.width) || !Number.isInteger(panel.height) || panel.width < 1 || panel.height < 1) {
    return '面宽和面高必须是正整数；保留原面，未排版。';
  }
  if (panel.width > size || panel.height > size) {
    return `${panel.width} × ${panel.height} 格超过 ${size} × ${size} 豆板，请选择更大豆板或先设计分片接缝；未缩放、未裁切。`;
  }
  if (!Array.isArray(panel.cells)) return '缺少豆子坐标；保留原面，未排版。';
  const coordinates = new Set();
  for (const cell of panel.cells) {
    if (!Number.isInteger(cell.x) || !Number.isInteger(cell.y) || cell.x < 0 || cell.y < 0 || cell.x >= panel.width || cell.y >= panel.height) {
      return '存在超出面边界或非整数的豆子坐标；保留原面，未排版。';
    }
    const key = `${cell.x},${cell.y}`;
    if (coordinates.has(key)) return '同一格出现重复豆子；保留原面，未排版。';
    coordinates.add(key);
  }
  return null;
}

const xml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
const validHex = (hex) => /^#[\da-f]{6}$/i.test(hex || '') ? hex : '#AEB6AD';

function textColor(hex) {
  const values = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  return luminance > 0.179 ? '#14201C' : '#FFFFFF';
}

/**
 * Render the entire pegboard, its placed panels, and a numbered part legend.
 * `hole:true` cells are intentional insertion slots; absent cells stay empty.
 */
export function boardSVG(board, options = {}) {
  const { labels = true, holes = true } = options;
  const size = board.size;
  const cellSize = 20;
  const margin = 48;
  const gridSize = size * cellSize;
  const width = gridSize + margin * 2;
  const placements = board.placements || [];
  const warnings = board.warnings || [];
  const legendRows = Math.max(1, Math.ceil(placements.length / 2));
  const footer = 70 + legendRows * 22 + warnings.length * 42;
  const height = gridSize + margin * 2 + footer;
  const index = board.index || 1;
  const result = [`<svg xmlns="http://www.w3.org/2000/svg" class="bead-board" role="img" aria-label="第 ${xml(index)} 块豆板，${size} 乘 ${size} 格" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `<title>第 ${xml(index)} 块豆板 · ${size} × ${size} 格</title>`,
    '<desc>带色号的彩色格放置豆子；H01 棋盘格放透明豆，不是白豆或空槽。琥珀色叉线格是预留插槽，不放豆；空白格也不放豆。箭头为各面的上方。每五格虚线、每十格粗线。</desc>',
    `<rect width="${width}" height="${height}" rx="8" fill="#FAFAF6"/>`,
    `<text x="${margin}" y="19" fill="#344C3F" font-family="sans-serif" font-size="12" font-weight="700">豆板 ${xml(index)} · ${size} × ${size} 格</text>`,
    `<text x="${width - margin}" y="19" fill="#68716B" text-anchor="end" font-family="sans-serif" font-size="10">↑ 朝上 · 单格对应一颗豆</text>`,
    `<rect x="${margin}" y="${margin}" width="${gridSize}" height="${gridSize}" fill="#FFFFFF"/>`];

  for (const { panel, x, y, number, labelRow } of placements) {
    const ox = margin + x * cellSize;
    const oy = margin + y * cellSize;
    result.push(`<g data-panel-id="${xml(panel.id)}"><title>${xml(panel.name || panel.id)} · ${panel.width} × ${panel.height} 格</title>`);
    result.push(`<rect x="${ox}" y="${oy}" width="${panel.width * cellSize}" height="${panel.height * cellSize}" fill="#F1F5EC" fill-opacity="0.5"/>`);
    for (const cell of [...panel.cells, ...(panel.slots || [])]) {
      const px = ox + cell.x * cellSize;
      const py = oy + cell.y * cellSize;
      if (cell.hole) {
        if (holes) result.push(`<g class="bead-slot"><rect x="${px + 2}" y="${py + 2}" width="16" height="16" fill="#FFF6DE" stroke="#A66B15" stroke-width="0.9" stroke-dasharray="2 2"/><path d="M${px + 6} ${py + 6}l8 8m0 -8l-8 8" stroke="#A66B15" stroke-width="0.8"/><title>预留插槽 · 不放豆</title></g>`);
      } else {
        const fill = validHex(cell.hex);
        const clear=cell.transparent||cell.code==='H01';
        result.push(`<g class="bead-cell${clear?' bead-clear':''}"><rect x="${px + 0.7}" y="${py + 0.7}" width="18.6" height="18.6" rx="2" fill="${clear?'#F1F7F7':fill}"${clear?' stroke="#94B3BA" stroke-width="0.65"':''}/>`);
        if(clear)result.push(`<path d="M${px+1} ${py+1}h9v9h-9zM${px+10} ${py+10}h9v9h-9z" fill="#D3E2E5"/>`);
        result.push(`<title>${xml(cell.code)} · ${clear?'透明豆（不是白色）':xml(fill)} · 第 ${x + cell.x + 1} 列，第 ${y + cell.y + 1} 行</title>`);
        if (labels) result.push(`<text x="${px + 10}" y="${py + 12.5}" text-anchor="middle" fill="${textColor(fill)}" font-family="sans-serif" font-size="6.5" font-weight="600">${xml(cell.code)}</text>`);
        else result.push(`<circle cx="${px + 10}" cy="${py + 10}" r="2.8" fill="#FFFFFF" fill-opacity="0.4"/>`);
        result.push('</g>');
      }
    }
    result.push(`<rect x="${ox + 0.4}" y="${oy + 0.4}" width="${panel.width * cellSize - 0.8}" height="${panel.height * cellSize - 0.8}" fill="none" stroke="#466956" stroke-width="1.2"/>`);
    if (labelRow) result.push(`<text x="${ox + 1}" y="${oy - 6}" font-family="sans-serif" font-size="9" fill="#345842" font-weight="700">${xml(panel.id || String(number || 1).padStart(2, '0'))} ↑</text>`);
    result.push('</g>');
  }

  // Grid is drawn last so every coordinate remains traceable across dark panels.
  for (let n = 0; n <= size; n++) {
    const pos = margin + n * cellSize;
    const major = n === 0 || n === size || n % 10 === 0;
    const five = !major && n % 5 === 0;
    const stroke = major ? '#68716B' : five ? '#7F8982' : '#D6DBD6';
    const thickness = major ? 1.8 : five ? 1 : 0.5;
    const dash = five ? ' stroke-dasharray="7 5"' : '';
    result.push(`<path d="M${pos} ${margin}v${gridSize}M${margin} ${pos}h${gridSize}" fill="none" stroke="${stroke}" stroke-width="${thickness}"${dash}/>`);
  }
  const ticks = [...new Set([1, ...Array.from({ length: Math.floor(size / 5) }, (_, i) => (i + 1) * 5), size])].sort((a, b) => a - b);
  for (const tick of ticks) {
    const pos = margin + (tick - 0.5) * cellSize;
    result.push(`<g font-family="sans-serif" font-size="10" fill="#4F5C53" text-anchor="middle"><text x="${pos}" y="${margin - 10}">${tick}</text><text x="${pos}" y="${margin + gridSize + 17}">${tick}</text><text x="${margin - 16}" y="${pos + 3.5}">${tick}</text><text x="${margin + gridSize + 16}" y="${pos + 3.5}">${tick}</text></g>`);
  }

  const footerY = margin + gridSize + 45;
  result.push(`<text x="${margin+520}" y="${footerY}" font-family="sans-serif" font-size="10" fill="#4F5C53">H01 棋盘格：透明豆 · H02：白色</text>`);
  result.push(`<g font-family="sans-serif" font-size="10" fill="#4F5C53"><rect x="${margin}" y="${footerY - 10}" width="12" height="12" rx="2" fill="#6D9870"/><text x="${margin + 18}" y="${footerY}">彩色格：放豆</text><rect x="${margin + 130}" y="${footerY - 10}" width="12" height="12" fill="#FFF6DE" stroke="#A66B15" stroke-dasharray="2 2"/><text x="${margin + 148}" y="${footerY}">叉线格：插槽，不放豆${holes ? '' : '（标记已隐藏）'}</text><text x="${margin + 390}" y="${footerY}">空白格：不放豆</text></g>`);
  for (const [i, placement] of placements.entries()) {
    const lx = margin + (i % 2) * (gridSize / 2);
    const ly = footerY + 27 + Math.floor(i / 2) * 22;
    const { panel, number } = placement;
    const title = `${panel.id || String(number || i + 1).padStart(2, '0')} ↑ ${panel.name || panel.id} · ${panel.width} × ${panel.height}${panel.seams?.length ? ' / '+panel.seams.join(' ') : ''}`;
    result.push(`<text x="${lx}" y="${ly}" fill="#344C3F" font-family="sans-serif" font-size="10">${xml(title)}</text>`);
  }
  warnings.forEach((warning, i) => {
    const y = footerY + 27 + legendRows * 22 + i * 42;
    // Wrap long warning text rather than placing an invisible line beyond the SVG.
    const limit = Math.max(10, Math.floor(gridSize / 11));
    const chunks = Array.from(String(warning));
    result.push(`<text x="${margin}" y="${y}" fill="#9A461B" font-family="sans-serif" font-size="11" font-weight="600">`);
    for (let start = 0; start < chunks.length; start += limit) result.push(`<tspan x="${margin}" dy="${start ? 16 : 0}">${xml(chunks.slice(start, start + limit).join(''))}</tspan>`);
    result.push('</text>');
  });
  result.push('</svg>');
  return result.join('');
}
