import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { prepareDependencies } from './prepare-dependencies.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (isMainThread) await prepareDependencies({quiet:true});
const sha = value => createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
const numberArg = (name, fallback) => {
  const pos = args.indexOf(name);
  return pos >= 0 ? Number(args[pos + 1]) : fallback;
};

if (!isMainThread) {
  const require = createRequire(import.meta.url);
  const { PNG } = require(path.join(workerData.nodeModules, 'pngjs'));
  let svgRasterizer;
  const images = new Map();
  const publicDir = path.join(root, 'public');
  async function png(url) {
    if (images.has(url)) return images.get(url);
    const pathname = decodeURIComponent(new URL(url, 'http://audit.local').pathname);
    const file = path.resolve(publicDir, `.${pathname}`);
    if (!file.startsWith(publicDir + path.sep)) throw new Error(`纹理路径越界：${url}`);
    const promise = fs.readFile(file).then(async bytes => {
      if (!file.toLowerCase().endsWith('.svg')) return PNG.sync.read(bytes);
      if (!svgRasterizer) {
        svgRasterizer = require(path.join(workerData.nodeModules, 'sharp'));
      }
      const image = await svgRasterizer(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { width: image.info.width, height: image.info.height, data: image.data };
    });
    images.set(url, promise);
    return promise;
  }
  globalThis.Image = class {
    set src(url) {
      png(url).then(image => {
        this.fixture = image;
        this.width = image.width;
        this.height = image.height;
        this.onload?.();
      }, () => this.onerror?.());
    }
  };
  globalThis.document = { createElement(type) {
    if (type !== 'canvas') throw new Error(`Unexpected mock element ${type}`);
    let image;
    return { getContext() { return { drawImage(input) { image = input.fixture; }, getImageData() { return { data: image.data }; } }; } };
  } };
  // Freeze the engine and its colour module for this run. Parent edits cannot mix versions
  // between replacement workers or during a long catalogue audit.
  const matchingUrl = `data:text/javascript;base64,${Buffer.from(workerData.matchingSource).toString('base64')}`;
  const engineSource = workerData.engineSource
    .replace(/from\s+(['"])three\1/g, `from ${JSON.stringify(workerData.threeUrl)}`)
    .replace(/(['"])\.\/color-matching\.js\1/g, JSON.stringify(matchingUrl));
  const { voxelize, buildPanels } = await import(`data:text/javascript;base64,${Buffer.from(engineSource).toString('base64')}`);
  const { packPanels } = await import(`data:text/javascript;base64,${Buffer.from(workerData.boardsSource).toString('base64')}`);
  parentPort.on('message', async task => {
    const start = performance.now();
    try {
      const data = await voxelize(task.model, task.entry, workerData.colors, 1);
      if (!data.voxels.size) {
        const urls = [...new Set([
          ...(task.model.layers || []),
          ...(task.model.elements || []).flatMap(el => Object.values(el.faces || {}).map(f => f.texture)),
        ].filter(url => typeof url === 'string' && !url.startsWith('#')))];
        const textures = await Promise.all(urls.map(async url => {
          const texture = await png(url);
          let alphaMax = 0, nonzero = 0, alpha100 = 0;
          for (let i = 3; i < texture.data.length; i += 4) {
            const a = texture.data[i];
            alphaMax = Math.max(alphaMax, a);
            if (a > 0) nonzero++;
            if (a >= 100) alpha100++;
          }
          return { url, width: texture.width, height: texture.height, alphaMax, nonzero, alpha100 };
        }));
        parentPort.postMessage({ taskId: task.id, status: 'empty', durationMs: Math.round(performance.now() - start), warnings: data.warnings, textures });
        return;
      }
      const result = buildPanels(data.voxels, { flat: data.flat });
      const boards = packPanels(result.panels, 52);
      const tiny = result.panels.filter(p => p.cells.length < 4);
      const strips = result.panels.filter(p => p.width === 1 || p.height === 1);
      const oversized = result.panels.filter(p => p.width > 52 || p.height > 52);
      const tinyBeads = tiny.reduce((sum, p) => sum + p.cells.length, 0);
      const fragmentation = tiny.length >= 8 || tinyBeads / result.surface.length >= 0.15 || result.panels.length > 150;
      parentPort.postMessage({
        taskId: task.id, status: result.surface.length ? 'generated' : 'empty', durationMs: Math.round(performance.now() - start),
        voxels: data.voxels.size, beads: result.surface.length, panels: result.panels.length, boards: boards.length,
        colors: result.palette.length, seams: result.seams.length, flat: data.flat,
        tinyPanels: tiny.length, tinyBeads, strips: strips.length, severeFragmentation: fragmentation,
        oversizedPanels: oversized.map(p => ({ id: p.id, width: p.width, height: p.height, beads: p.cells.length })),
        warnings: [...new Set([...data.warnings, ...result.warnings, ...boards.flatMap(b => b.warnings)])],
      });
    } catch (error) {
      parentPort.postMessage({ taskId: task.id, status: 'error', error: error.message, durationMs: Math.round(performance.now() - start) });
    }
  });
} else {
  const started = Date.now();
  const maxMs = numberArg('--max-ms', 180000);
  const modelTimeoutMs = numberArg('--model-timeout-ms', 20000);
  const concurrency = numberArg('--workers', 3);
  const batchSize = numberArg('--batch-size', Infinity);
  if (![maxMs, modelTimeoutMs, concurrency].every(v => Number.isFinite(v) && v > 0)) throw new Error('Invalid audit limits');
  const read = rel => fs.readFile(path.join(root, rel), 'utf8');
  const [catalogText, entitiesText, paletteText, engineSource, boardsSource, appSource, auditSource, matchingSource, itemModelsSource] = await Promise.all([
    read('public/data/catalog.json'), read('public/data/entities.json'), read('public/data/palette.json'),
    read('public/src/engine.js'), read('public/src/boards.js'), read('public/src/app.js'), read('scripts/audit-patterns.mjs'), read('public/src/color-matching.js'), read('public/src/item-models.js'),
  ]);
  const catalog = JSON.parse(catalogText), entities = JSON.parse(entitiesText), palette = JSON.parse(paletteText);
  const {resolveItemModel} = await import(`data:text/javascript;base64,${Buffer.from(itemModelsSource).toString('base64')}`);
  const sourceHashes = { catalog: sha(catalogText), entities: sha(entitiesText), palette: sha(paletteText), engine: sha(engineSource), colorMatching: sha(matchingSource), itemModels: sha(itemModelsSource), boards: sha(boardsSource), app: sha(appSource), audit: sha(auditSource) };
  const signature = sha(JSON.stringify(sourceHashes));
  const entryMap = new Map(catalog.entries.map(e => [e.key, e]));
  const modelFiles = new Map();
  async function modelFile(url) {
    if (!url) throw new Error('目录项未提供模型地址');
    if (!modelFiles.has(url)) modelFiles.set(url, read(`public${url}`).then(JSON.parse));
    return modelFiles.get(url);
  }
  // Mirrors app.js resolveModel, including special block/item aliases and
  // sourceEntry propagation for dynamic entity item/block display models.
  async function resolveModel(entry, depth = 0) {
    if (depth > 3) throw new Error('模型引用出现循环');
    const id = entry.id.replace('minecraft:', '');
    if (entry.kind === 'item') return resolveItemModel(entry, entities, modelFile);
    if (entry.kind === 'entity') {
      const info = entities.entities?.[id];
      if (entities.models?.[info?.model || id]) return { model: entities.models[info?.model || id], note: info?.note };
      if (info?.status === 'item-model' || info?.status === 'block-model') {
        const kind = info.status === 'item-model' ? 'item' : 'block';
        const name = (info.item || info.block || '').replace('minecraft:', '');
        const ref = entryMap.get(`${kind}/${name}`);
        if (ref) return { ...await resolveModel(ref, depth + 1), sourceEntry: ref, note: info.note || `此实体使用原版 ${ref.name} 的显示模型。` };
      }
      throw new Error(info?.note || '此实体的显示内容由游戏状态决定，没有固定模型。');
    }
    const specialKey = entities.blockEntities?.[id];
    if (specialKey && entities.specialModels?.[specialKey]) return { model: entities.specialModels[specialKey] };
    if (entities.specialModels?.[id]) return { model: entities.specialModels[id] };
    const model = await modelFile(entry.model);
    if (model.renderType === 'special' || (!model.elements?.length && !model.layers?.length)) {
      if (entry.status === 'invisible') throw new Error('这个对象在原版中没有可见表面，因此没有可制作的拼豆图纸。');
      throw new Error('此模型需要原版专用渲染数据，目前尚未取得可用的固定表面。');
    }
    return { model };
  }
  const groups = new Map(), records = [];
  for (const entry of catalog.entries) {
    const record = { key: entry.key, id: entry.id, kind: entry.kind, name: entry.name };
    records.push(record);
    try {
      const resolved = await resolveModel(entry);
      const effective = resolved.sourceEntry || entry;
      const modelHash = sha(JSON.stringify({ model: resolved.model, thumbnail: !resolved.model.elements?.length ? effective.thumbnail : null }));
      record.modelHash = modelHash;
      if (resolved.note) record.note = resolved.note;
      if (resolved.sourceEntry) record.sourceEntry = resolved.sourceEntry.key;
      record.status = 'unprocessed';
      if (!groups.has(modelHash)) groups.set(modelHash, { id: modelHash, model: resolved.model, entry: effective, records: [] });
      groups.get(modelHash).records.push(record);
    } catch (error) {
      const info = entities.entities?.[entry.id.replace('minecraft:', '')];
      record.status = entry.status === 'invisible' || info?.status === 'invisible' ? 'invisible' : 'unavailable';
      record.error = error.message;
    }
  }
  if (args.includes('--resume')) {
    try {
      const previous = JSON.parse(await read('docs/coverage.json'));
      if (previous.signature === signature) {
        const byHash = new Map(previous.entries.filter(e => e.modelHash && !['unprocessed', 'timeout'].includes(e.status)).map(e => [e.modelHash, e]));
        for (const group of groups.values()) {
          const old = byHash.get(group.id);
          if (!old) continue;
          const { key, id, name, kind, note, sourceEntry, ...stats } = old;
          for (const record of group.records) Object.assign(record, stats);
          group.completed = true;
        }
      } else console.log('Inputs changed; starting a fresh coverage audit.');
    } catch { /* First run has no checkpoint. */ }
  }
  const pending = [...groups.values()].filter(g => !g.completed).slice(0, batchSize);
  const require = createRequire(import.meta.url);
  const threeUrl = pathToFileURL(require.resolve('three')).href;
  const nodeModules = path.join(root, 'vendor/node');
  const runtimeData = { engineSource, matchingSource, boardsSource, threeUrl, colors: palette.colors, nodeModules };
  let position = 0, done = 0, finished = false;
  const active = new Set();
  let checkpointPromise = Promise.resolve();
  function checkpoint() {
    const statuses = {}, categories = {}, flags = { oversizedEntries: 0, severeFragmentationEntries: 0 };
    for (const row of records) {
      statuses[row.status] = (statuses[row.status] || 0) + 1;
      categories[row.kind] ||= {};
      categories[row.kind][row.status] = (categories[row.kind][row.status] || 0) + 1;
      if (row.oversizedPanels?.length) flags.oversizedEntries++;
      if (row.severeFragmentation) flags.severeFragmentationEntries++;
    }
    const output = {
      schemaVersion: 1, version: catalog.version, generatedAt: new Date().toISOString(), signature, sourceHashes,
      verification: '离线读取真实 PNG，并以 sharp 栅格化 SVG 纹理，执行与网页相同的模型解析、1倍体素化、分面、52格排版；未验证实物熨烫或装配。',
      limits: { maxMs, modelTimeoutMs, workers: concurrency, completedBatchTasks: done },
      complete: !records.some(e => ['unprocessed', 'timeout'].includes(e.status)), elapsedMs: Date.now() - started,
      totalEntries: records.length, uniqueModels: groups.size, statuses, categories, flags,
      fragmentationDefinition: '不足4豆的小面至少8片，或占总豆数15%以上，或总面数超过150。',
      entries: records,
    };
    const serialized = JSON.stringify(output, null, 2) + '\n';
    checkpointPromise = checkpointPromise.then(async () => {
      for (const relative of ['docs/coverage.json', 'public/data/coverage.json']) {
        const target = path.join(root, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(`${target}.tmp`, serialized);
        await fs.rename(`${target}.tmp`, target);
      }
    });
    return output;
  }
  const applyResult = (group, result) => {
    const { taskId, ...stats } = result;
    for (const record of group.records) Object.assign(record, stats);
    done++;
    if (result.status !== 'generated') console.log(`${result.status}: ${group.records.map(r => r.key).join(', ')} ${result.error || ''}`);
    if (done % 50 === 0) { console.log(`Audited ${done}/${pending.length} distinct models (${Math.round((Date.now() - started) / 1000)}s)`); checkpoint(); }
  };
  const completion = new Promise(resolve => {
    function end() {
      if (finished) return;
      finished = true;
      for (const item of active) { clearTimeout(item.timer); item.worker.terminate(); }
      active.clear();
      resolve();
    }
    function assign(item) {
      if (finished) return;
      if (position >= pending.length) {
        clearTimeout(item.timer);
        active.delete(item);
        item.worker.terminate();
        if (!active.size) end();
        return;
      }
      item.group = pending[position++];
      item.timer = setTimeout(() => {
        if (finished) return;
        applyResult(item.group, { status: 'timeout', error: `单模型超过 ${modelTimeoutMs}ms，已终止该工作线程。` });
        active.delete(item);
        item.worker.terminate();
        spawn();
      }, modelTimeoutMs);
      item.worker.postMessage({ id: item.group.id, model: item.group.model, entry: item.group.entry });
    }
    function spawn() {
      if (finished) return;
      const item = { worker: new Worker(new URL(import.meta.url), { workerData: runtimeData }), timer: null, group: null };
      active.add(item);
      item.worker.on('message', result => { clearTimeout(item.timer); applyResult(item.group, result); assign(item); });
      item.worker.on('error', error => {
        if (finished) return;
        clearTimeout(item.timer);
        if (item.group) applyResult(item.group, { status: 'error', error: error.message });
        active.delete(item);
        item.worker.terminate();
        spawn();
      });
      assign(item);
    }
    if (!pending.length) { end(); return; }
    for (let i = 0; i < Math.min(concurrency, pending.length); i++) spawn();
    setTimeout(end, Math.max(1, maxMs - (Date.now() - started))).unref();
  });
  console.log(`Catalogue ${records.length} entries; ${groups.size} distinct render inputs; auditing ${pending.length} with ${concurrency} workers and ${maxMs}ms hard limit.`);
  await completion;
  const result = checkpoint();
  await checkpointPromise;
  console.log(JSON.stringify({ complete: result.complete, elapsedMs: result.elapsedMs, totalEntries: result.totalEntries, uniqueModels: result.uniqueModels, statuses: result.statuses, flags: result.flags }));
  if (!result.complete) process.exitCode = 2;
}
