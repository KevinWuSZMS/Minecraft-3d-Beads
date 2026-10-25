import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {prepareDependencies} from './prepare-dependencies.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(isMainThread)await prepareDependencies({quiet:true});
const publicDir=path.join(root,'public');
const sha=value=>createHash('sha256').update(value).digest('hex');
const moduleUrl=source=>`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const check=(value,message)=>{if(!value)throw new Error(message)};

if(!isMainThread){
  const require=createRequire(import.meta.url);
  const dependency=name=>require(path.join(workerData.nodeModules,name));
  const {PNG}=dependency('pngjs');let sharp;
  const images=new Map();
  function localPath(url){const pathname=decodeURIComponent(new URL(url,'http://audit.local').pathname);const result=path.resolve(publicDir,'.'+pathname);check(result.startsWith(publicDir+path.sep),'Resource leaves public directory: '+url);return result}
  async function image(url){
    if(!images.has(url))images.set(url,fs.readFile(localPath(url)).then(async bytes=>{
      if(!url.toLowerCase().endsWith('.svg'))return PNG.sync.read(bytes);
      sharp||=dependency('sharp');const result=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      return {width:result.info.width,height:result.info.height,data:result.data};
    }));
    return images.get(url);
  }
  globalThis.Image=class{set src(url){image(url).then(texture=>{this.fixture=texture;this.width=texture.width;this.height=texture.height;this.onload?.()},()=>this.onerror?.())}};
  globalThis.document={createElement(type){check(type==='canvas','Unexpected mock DOM '+type);let texture;return {getContext(){return {drawImage(value){texture=value.fixture},getImageData(){return {data:texture.data}}}}}}};
  globalThis.fetch=async url=>{try{const bytes=await fs.readFile(localPath(url));return {ok:true,status:200,json:async()=>JSON.parse(bytes)}}catch{return {ok:false,status:404,json:async()=>{throw new Error('Missing local metadata')}}}};
  const matchingUrl=moduleUrl(workerData.matchingSource);
  const engineUrl=moduleUrl(workerData.engineSource.replace(/from\s+(['"])three\1/g,`from ${JSON.stringify(workerData.threeUrl)}`).replace(/(['"])\.\/color-matching\.js\1/g,JSON.stringify(matchingUrl)));
  const facesUrl=moduleUrl(workerData.facesSource.replace(/(['"])\.\/engine\.js\1/g,JSON.stringify(engineUrl)).replace(/(['"])\.\/color-matching\.js\1/g,JSON.stringify(matchingUrl)));
  const {buildTextureFaces}=await import(facesUrl);
  const {packPanels}=await import(moduleUrl(workerData.boardsSource));
  const colors=workerData.colors,byCode=new Map(colors.map(color=>[color.code,color]));
  const cellKey=cell=>cell.x+','+cell.y;

  async function sourceAlpha(panel){
    const frames=await Promise.all(panel.sourceFrames.map(async frame=>({...frame,image:await image(frame.texture)})));
    const [width,height]=panel.sourceSize,mask=new Uint8Array(width*height);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      for(const frame of frames){
        let sx,sy;
        if(frame.kind==='atlas-crop'){
          const ow=frame.outputWidth,oh=frame.outputHeight;
          const lx=Math.min(ow-1,Math.floor(x*ow/width)),ly=Math.min(oh-1,Math.floor(y*oh/height));
          let u=(lx+.5)/ow,v=(ly+.5)/oh;
          const turns=((Math.round(frame.rotation/90)%4)+4)%4;
          for(let turn=0;turn<turns;turn++)[u,v]=[v,1-u];
          const uv=frame.uv.map((value,index)=>value*([frame.canvasWidth,frame.canvasHeight][index%2]/frame.textureSize[index%2]));
          sx=Math.max(0,Math.min(frame.image.width-1,Math.floor(uv[0]+u*(uv[2]-uv[0]))));
          sy=Math.max(0,Math.min(frame.image.height-1,Math.floor(uv[1]+v*(uv[3]-uv[1]))));
        }else{
          sx=frame.x+Math.min(frame.width-1,Math.floor(x*frame.width/width));
          sy=frame.y+Math.min(frame.height-1,Math.floor(y*frame.height/height));
        }
        check(sx>=0&&sy>=0&&sx<frame.image.width&&sy<frame.image.height,`${panel.id}: source pixel outside original texture`);
        if(frame.image.data[(sy*frame.image.width+sx)*4+3]>0){mask[y*width+x]=1;break}
      }
    }
    return mask;
  }
  function verifyResult(result,boards,filled){
    check(result.patternMode==='faces','Wrong pattern mode');
    check(result.seams?.length===0,'Texture faces have assembly seams');
    const tally=new Map(),ids=new Set(),worldCells=new Set();let panelBeads=0;
    for(const panel of result.panels){
      check(!ids.has(panel.id),'Duplicate panel ID');ids.add(panel.id);
      check(panel.width===panel.sourceSize[0]&&panel.height===panel.sourceSize[1],`${panel.id}: source dimensions were cropped or resized`);
      check(!(panel.slots?.length)&&!(panel.seams?.length),`${panel.id}: texture face has slots/seams`);
      check(panel.sourceFrames?.length>0,`${panel.id}: missing source-frame provenance`);
      check(panel.width===Math.max(...panel.sourceFrames.map(frame=>frame.outputWidth))&&panel.height===Math.max(...panel.sourceFrames.map(frame=>frame.outputHeight)),`${panel.id}: source layer dimensions disagree with panel`);
      const positions=new Set();
      for(const cell of panel.cells){
        check(Number.isInteger(cell.x)&&Number.isInteger(cell.y)&&cell.x>=0&&cell.y>=0&&cell.x<panel.width&&cell.y<panel.height,`${panel.id}: out-of-bounds bead`);
        check(!positions.has(cellKey(cell)),`${panel.id}: duplicate bead`);positions.add(cellKey(cell));
        check(!cell.slot,`${panel.id}: assembly slot flag on texture bead`);
        const canonical=byCode.get(cell.code);check(canonical&&canonical.hex.toUpperCase()===cell.hex.toUpperCase(),`${panel.id}: invalid MARD code/hex`);
        check(Boolean(cell.transparent)===(cell.code==='H01'),`${panel.id}: transparency marker/code mismatch`);
        if(!filled)check(cell.code!=='H01',`${panel.id}: H01 used while fill is disabled`);
        const position=cell.p.join(',');check(!worldCells.has(position),'3D preview has overlapping texture beads');worldCells.add(position);
        const key=cell.code+':'+Number(Boolean(cell.transparent));tally.set(key,(tally.get(key)||0)+1);panelBeads++;
      }
      if(filled)check(panel.cells.length===panel.width*panel.height,`${panel.id}: filled texture is not a complete rectangle`);
    }
    check(panelBeads===result.surface.length,'Surface count differs from panel cells');
    const materials=new Map(result.palette.map(color=>[color.code+':'+Number(Boolean(color.transparent)),color.count]));
    check(materials.size===tally.size&&[...tally].every(([key,count])=>materials.get(key)===count),'Materials do not match exact panel cells');
    let represented=0;const packedIds=new Set();
    for(const board of boards){
      const boardCells=new Set();
      for(const placement of board.placements){
        check(!packedIds.has(placement.panel.id),'Panel placed more than once');packedIds.add(placement.panel.id);
        for(const cell of placement.panel.cells){const x=cell.x+placement.x,y=cell.y+placement.y,key=x+','+y;check(x>=0&&y>=0&&x<52&&y<52,'Board bead outside 52x52');check(!boardCells.has(key),'Board panels overlap');boardCells.add(key);represented++}
      }
      for(const panel of board.unplaced||[]){
        check(panel.width>52||panel.height>52,'A fitting panel was rejected by board packing');
        check(!packedIds.has(panel.id),'Unplaced panel duplicated');packedIds.add(panel.id);represented+=panel.cells.length;
      }
    }
    check(represented===panelBeads&&packedIds.size===result.panels.length,'Board packing dropped/cropped a panel or bead');
    return {beads:panelBeads,boards:boards.length,colors:result.palette.length,transparentBeads:result.surface.filter(cell=>cell.code==='H01').length};
  }
  parentPort.on('message',async task=>{
    const start=performance.now();
    try{
      const base=await buildTextureFaces(task.model,task.entry,colors,1,{colorMode:'detail',fillTransparent:false});
      const fill=await buildTextureFaces(task.model,task.entry,colors,1,{colorMode:'detail',fillTransparent:true});
      check(base.panels.length>0,'Visible block has no source texture panels');
      check(base.panels.length===fill.panels.length,'Fill changes the number of distinct texture panels');
      const baseBoards=packPanels(base.panels,52),fillBoards=packPanels(fill.panels,52);
      const unfilled=verifyResult(base,baseBoards,false),filled=verifyResult(fill,fillBoards,true);
      check(baseBoards.length===fillBoards.length,'Fill changes board count although panel dimensions are unchanged');
      const sourceKeys=new Set();let sourceOpaque=0,sourceTransparent=0;
      for(let i=0;i<base.panels.length;i++){
        const a=base.panels[i],b=fill.panels[i];
        check(a.id===b.id&&a.width===b.width&&a.height===b.height&&JSON.stringify(a.sourceFrames)===JSON.stringify(b.sourceFrames),'Fill changes a source face or dimensions');
        const signature=JSON.stringify([a.sourceTextures,a.sourceSize,a.sourceTints,a.sourceFrames]);
        check(!sourceKeys.has(signature),'Duplicate identical source texture panel was not deduplicated');sourceKeys.add(signature);
        const baseline=new Map(a.cells.map(cell=>[cellKey(cell),cell])),complete=new Map(b.cells.map(cell=>[cellKey(cell),cell]));
        const mask=await sourceAlpha(a);
        for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){
          const key=x+','+y,old=baseline.get(key),now=complete.get(key),opaque=Boolean(mask[y*a.width+x]);
          if(opaque){sourceOpaque++;check(old&&now,`${a.id}: source-colored texel is missing`);check(old.code===now.code&&old.hex===now.hex,`${a.id}: filling transparency changed a colored texel`);check(now.code!=='H01',`${a.id}: H01 replaced a colored source texel`)}
          else{sourceTransparent++;check(!old,`${a.id}: unfilled pattern includes transparent source texel`);check(now?.code==='H01'&&now.transparent,`${a.id}: transparent source texel was not filled with H01`)}
        }
      }
      check(unfilled.beads===sourceOpaque&&filled.transparentBeads===sourceTransparent,'Independent source-alpha totals disagree');
      const oversized=base.panels.filter(panel=>panel.width>52||panel.height>52).map(panel=>({id:panel.id,width:panel.width,height:panel.height}));
      parentPort.postMessage({taskId:task.id,status:'verified',durationMs:Math.round(performance.now()-start),distinctFaces:base.panels.length,unfilled,filled,sourceOpaque,sourceTransparent,oversized,
        faceSizes:base.panels.map(panel=>({id:panel.id,width:panel.width,height:panel.height,textures:panel.sourceTextures,sourceFrames:panel.sourceFrames})),warnings:[...new Set([...base.warnings,...fill.warnings,...baseBoards.flatMap(board=>board.warnings)])]});
    }catch(error){parentPort.postMessage({taskId:task.id,status:'error',error:error.message,durationMs:Math.round(performance.now()-start)})}
  });
}else{
  const started=Date.now(),args=process.argv.slice(2);
  const numberArg=(name,fallback)=>{const index=args.indexOf(name);return index>=0?Number(args[index+1]):fallback};
  const maxMs=Math.min(180000,numberArg('--max-ms',180000)),modelTimeoutMs=numberArg('--model-timeout-ms',15000),concurrency=numberArg('--workers',3);
  check([maxMs,modelTimeoutMs,concurrency].every(value=>Number.isFinite(value)&&value>0),'Invalid audit limits');
  const read=relative=>fs.readFile(path.join(root,relative),'utf8');
  const paths={catalog:'public/data/catalog.json',entities:'public/data/entities.json',palette:'public/data/palette.json',faces:'public/src/texture-faces.js',engine:'public/src/engine.js',matching:'public/src/color-matching.js',boards:'public/src/boards.js',audit:'scripts/audit-texture-faces.mjs'};
  const sources=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([key,file])=>[key,await read(file)])));
  const sourceHashes=Object.fromEntries(Object.entries(sources).map(([key,source])=>[key,sha(source)]));
  const catalog=JSON.parse(sources.catalog),entities=JSON.parse(sources.entities),palette=JSON.parse(sources.palette);
  const blocks=catalog.entries.filter(entry=>entry.kind==='block');check(blocks.length===1060,'Expected all 1060 Java 1.21.1 block registry entries');
  const records=[],tasks=[];
  for(const entry of blocks){
    const record={key:entry.key,id:entry.id,name:entry.name,status:'unprocessed'};records.push(record);
    try{
      const id=entry.id.replace('minecraft:',''),specialKey=entities.blockEntities?.[id];
      const model=specialKey&&entities.specialModels?.[specialKey]||entities.specialModels?.[id]||(entry.model?JSON.parse(await read('public'+entry.model)):null);
      if(!model?.elements?.length&&!model?.layers?.length){
        if(entry.status==='invisible'){record.status='invisible';record.note='原版方块没有可见纹理表面。';continue}
        throw new Error('Missing source model');
      }
      record.modelHash=sha(JSON.stringify(model));tasks.push({id:entry.key,entry,model});
    }catch(error){record.status='error';record.error=error.message}
  }
  const require=createRequire(import.meta.url),threeUrl=pathToFileURL(require.resolve('three')).href;
  const nodeModules=path.join(root,'vendor/node');
  const runtimeData={engineSource:sources.engine,matchingSource:sources.matching,facesSource:sources.faces,boardsSource:sources.boards,colors:palette.colors,nodeModules,threeUrl};
  const byKey=new Map(records.map(record=>[record.key,record]));let position=0,completed=0,finished=false;
  const active=new Set();
  const completion=new Promise(resolve=>{
    function stop(){if(finished)return;finished=true;for(const item of active){clearTimeout(item.timer);item.worker.terminate()}active.clear();resolve()}
    function result(task,outcome){const {taskId,...fields}=outcome;Object.assign(byKey.get(task.id),fields);completed++;if(fields.status!=='verified')console.log(`${fields.status}: ${task.id}: ${fields.error}`);if(completed%100===0)console.log(`Verified ${completed}/${tasks.length} block textures (${Math.round((Date.now()-started)/1000)}s)`)}
    function assign(item){
      if(finished)return;
      if(position>=tasks.length){clearTimeout(item.timer);active.delete(item);item.worker.terminate();if(!active.size)stop();return}
      item.task=tasks[position++];item.timer=setTimeout(()=>{if(finished)return;result(item.task,{status:'timeout',error:`Model exceeded ${modelTimeoutMs}ms`});active.delete(item);item.worker.terminate();spawn()},modelTimeoutMs);item.worker.postMessage(item.task);
    }
    function spawn(){if(finished)return;const item={worker:new Worker(new URL(import.meta.url),{workerData:runtimeData}),timer:null,task:null};active.add(item);item.worker.on('message',outcome=>{clearTimeout(item.timer);result(item.task,outcome);assign(item)});item.worker.on('error',error=>{if(finished)return;clearTimeout(item.timer);if(item.task)result(item.task,{status:'error',error:error.message});active.delete(item);item.worker.terminate();spawn()});assign(item)}
    if(!tasks.length){stop();return}
    for(let i=0;i<Math.min(concurrency,tasks.length);i++)spawn();
    setTimeout(stop,Math.max(1,maxMs-(Date.now()-started))).unref();
  });
  console.log(`Texture-face audit: ${blocks.length} blocks, ${tasks.length} visible models, ${concurrency} workers, ${maxMs}ms hard limit.`);
  await completion;
  const statuses={},totals={distinctFaces:0,unfilledBeads:0,filledBeads:0,transparentBeads:0,unfilledBoards:0,filledBoards:0,oversizedEntries:0,oversizedFaces:0};
  for(const record of records){statuses[record.status]=(statuses[record.status]||0)+1;if(record.status!=='verified')continue;totals.distinctFaces+=record.distinctFaces;totals.unfilledBeads+=record.unfilled.beads;totals.filledBeads+=record.filled.beads;totals.transparentBeads+=record.filled.transparentBeads;totals.unfilledBoards+=record.unfilled.boards;totals.filledBoards+=record.filled.boards;totals.oversizedEntries+=Number(record.oversized.length>0);totals.oversizedFaces+=record.oversized.length}
  const output={schemaVersion:1,version:catalog.version,generatedAt:new Date().toISOString(),sourceHashes,signature:sha(JSON.stringify(sourceHashes)),elapsedMs:Date.now()-started,complete:!records.some(record=>['unprocessed','timeout'].includes(record.status)),limits:{maxMs,modelTimeoutMs,workers:concurrency},
    verification:'离线加载原始PNG/SVG与动画mcmeta，执行网页同一buildTextureFaces和52格packPanels；每个可见方块比较透明留空/填H01两种模式，并从源图层alpha独立复算每格位置。',
    checks:['源纹理尺寸与透明边缘保留','去重后的面无重复格/slots/seams','材料、预览、面片和豆板数量一致','H01仅填源alpha0；原有色号不变','超过52的完整面保留在unplaced且不裁切'],
    limitsNotice:'仅检查Java 1.21.1当前展示状态、1像素=1豆与默认细节配色；不代表所有方块状态、浏览器视觉或实物熨烫验收。',totalBlocks:blocks.length,statuses,totals,entries:records};
  const target=path.join(root,'docs/texture-face-coverage.json');await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target+'.tmp',JSON.stringify(output,null,2)+'\n');await fs.rename(target+'.tmp',target);
  console.log(JSON.stringify({complete:output.complete,elapsedMs:output.elapsedMs,statuses,totals},null,2));
  if(!output.complete)process.exitCode=2;else if(statuses.error)process.exitCode=1;
}
