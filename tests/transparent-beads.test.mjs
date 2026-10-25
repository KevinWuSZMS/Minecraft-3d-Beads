import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {voxelize,buildPanels} from '../public/src/engine.js';
import {packPanels,boardSVG} from '../public/src/boards.js';
import {makeMatcher} from '../public/src/color-matching.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const {PNG}=require(path.join(root,'vendor/node/pngjs'));
const catalog=JSON.parse(await fs.readFile(path.join(root,'public/data/catalog.json'),'utf8'));
const colors=JSON.parse(await fs.readFile(path.join(root,'public/data/palette.json'),'utf8')).colors;
const originals={Image:globalThis.Image,document:globalThis.document};
const imageCache=new Map();
const alphaPixels=[[255,0,255,0],[255,255,255,1],[100,80,60,127],[160,120,80,128],[50,120,200,255]];
imageCache.set('/fixtures/transparent-alpha.png',Promise.resolve({width:5,height:1,data:Uint8ClampedArray.from(alphaPixels.flat())}));
imageCache.set('/fixtures/transparent-base.png',Promise.resolve({width:5,height:1,data:Uint8ClampedArray.from(Array.from({length:5},()=>[20,100,30,255]).flat())}));
async function image(url) {
  if(!imageCache.has(url))imageCache.set(url,fs.readFile(path.join(root,'public',url)).then(bytes=>PNG.sync.read(bytes)));
  return imageCache.get(url);
}
before(()=>{
  globalThis.Image=class {
    set src(url) { image(url).then(texture=>{this.fixture=texture;this.width=texture.width;this.height=texture.height;this.onload?.();},()=>this.onerror?.()); }
  };
  globalThis.document={createElement(type) {
    assert.equal(type,'canvas');let texture;
    return {getContext(){return {drawImage(value){texture=value.fixture;},getImageData(){return {data:texture.data};}};}};
  }};
});
after(()=>{for(const [name,value]of Object.entries(originals)){if(value===undefined)delete globalThis[name];else globalThis[name]=value;}});
async function input(key) {
  const entry=catalog.entries.find(value=>value.key===key);
  assert.ok(entry,`Missing ${key}`);
  return {entry,model:JSON.parse(await fs.readFile(path.join(root,'public',entry.model),'utf8'))};
}
function compareFill(empty,filled,label) {
  let added=0;
  for(const [key,voxel]of empty.voxels) {
    const after=filled.voxels.get(key);
    assert.ok(after,`${label}: fill must not remove ${key}`);
    voxel.colors.forEach((color,index)=>{
      if(color){assert.notEqual(color.code,'H01');assert.equal(after.colors[index]?.code,color.code,`${label}: altered colored pixel ${key}/${index}`);}
      else if(after.colors[index]){assert.equal(after.colors[index].code,'H01');assert.equal(after.colors[index].transparent,true);added++;}
    });
  }
  for(const [key,voxel]of filled.voxels)if(!empty.voxels.has(key)) {
    for(const color of voxel.colors.filter(Boolean)){assert.equal(color.code,'H01');assert.equal(color.transparent,true);added++;}
  }
  return added;
}
function verifyBoards(result) {
  const clear=result.surface.filter(cell=>cell.code==='H01');
  assert.ok(clear.length>0,'Glass must contain physical H01 beads');
  assert.ok(clear.every(cell=>cell.transparent===true&&!cell.hole),'Clear beads are occupied cells, not insertion holes');
  const materials=result.palette.find(color=>color.code==='H01');
  assert.equal(materials.count,clear.length);
  assert.equal(materials.transparent,true);
  assert.equal(result.palette.reduce((sum,color)=>sum+color.count,0),result.surface.length);
  let slotCount=0;
  for(const panel of result.panels) {
    const occupied=new Set(panel.cells.map(cell=>`${cell.x},${cell.y}`));
    for(const slot of panel.slots){assert.equal(slot.hole,true);assert.equal(slot.code,undefined);assert.ok(!occupied.has(`${slot.x},${slot.y}`));slotCount++;}
  }
  assert.ok(slotCount>0,'Real glass cube must retain interlocking slots');
  const boards=packPanels(result.panels,52);
  assert.ok(boards.every(board=>!board.unplaced?.length));
  const svgs=boards.map(board=>boardSVG(board));
  assert.equal(svgs.reduce((sum,svg)=>sum+(svg.match(/class="bead-cell bead-clear"/g)||[]).length,0),clear.length);
  assert.equal(svgs.reduce((sum,svg)=>sum+(svg.match(/class="bead-slot"/g)||[]).length,0),slotCount);
  assert.equal(svgs.reduce((sum,svg)=>sum+(svg.match(/<title>H01 · 透明豆（不是白色）/g)||[]).length,0),clear.length);
  assert.ok(svgs.some(svg=>svg.includes('fill="#D3E2E5"')),'Clear beads have checkerboard marks');
  const hiddenSlots=boards.map(board=>boardSVG(board,{holes:false,labels:false}));
  assert.ok(hiddenSlots.every(svg=>!svg.includes('class="bead-slot"')));
  assert.equal(hiddenSlots.reduce((sum,svg)=>sum+(svg.match(/class="bead-cell bead-clear"/g)||[]).length,0),clear.length,'Hiding slot annotations must not remove transparent beads');
}

test('real glass adds only H01, while grass overlays and white wool keep every existing colored bead',async()=>{
  for(const key of ['block/glass','block/grass_block','block/white_wool']) {
    const {entry,model}=await input(key);
    for(const [scale,colorMode,mix2x2]of [[1,'legacy',false],[1,'accurate',false],[1,'detail',false],[2,'detail',true]]) {
      const options={colorMode,mix2x2};
      const empty=await voxelize(model,entry,colors,scale,options);
      const filled=await voxelize(model,entry,colors,scale,{...options,fillTransparent:true});
      const label=`${key}/${scale}/${colorMode}`;
      const added=compareFill(empty,filled,label);
      const result=buildPanels(filled.voxels,{flat:filled.flat});
      if(key==='block/glass') {
        assert.ok(added>0,`${label}: glass has alpha-zero areas to fill`);
        verifyBoards(result);
        const byPosition=new Map(result.surface.map(cell=>[cell.p.join(','),cell]));
        for(const cell of buildPanels(empty.voxels).surface)assert.equal(byPosition.get(cell.p.join(','))?.code,cell.code,'Fill preserves every existing colored surface bead');
      } else {
        assert.equal(added,0,`${label}: clear overlay pixels must preserve the opaque base`);
        assert.ok(result.surface.every(cell=>cell.code!=='H01'));
        assert.ok(!result.palette.some(color=>color.code==='H01'));
      }
    }
  }
});

test('generated textures retain every nonzero alpha, and the fill switch adds only alpha-zero H01 beads',async()=>{
  const model={layers:['/fixtures/transparent-alpha.png'],fullTexture:true};
  for(const scale of [1,2]) {
    const empty=await voxelize(model,{},colors,scale,{colorMode:'accurate'});
    const filled=await voxelize(model,{},colors,scale,{colorMode:'accurate',fillTransparent:true});
    assert.equal(empty.voxels.size,4*scale*scale);
    assert.equal(filled.voxels.size,5*scale*scale);
    compareFill(empty,filled,`generated/${scale}`);
    const match=makeMatcher(colors);
    for(let x=0;x<5*scale;x++)for(let y=0;y<scale;y++) {
      const cell=filled.voxels.get(`${x},${y},0`),source=alphaPixels[Math.floor(x/scale)];
      assert.ok(cell);
      assert.equal(cell.colors[4].code,source[3]===0?'H01':match(source.slice(0,3)).code);
    }
    assert.equal(filled.voxels.get(`${scale},0,0`).colors[4].code,'H02','Alpha=1 pure white remains a white bead');
    const result=buildPanels(filled.voxels,{flat:true});
    assert.equal(result.palette.find(color=>color.code==='H01').count,scale*scale);
    assert.equal(result.surface.length,5*scale*scale);
  }
});

test('generated layer composition preserves the opaque base under alpha-zero and retains semi-transparent RGB',async()=>{
  const model={layers:['/fixtures/transparent-base.png','/fixtures/transparent-alpha.png'],fullTexture:true};
  const empty=await voxelize(model,{},colors,1,{colorMode:'accurate'});
  const filled=await voxelize(model,{},colors,1,{colorMode:'accurate',fillTransparent:true});
  assert.equal(compareFill(empty,filled,'generated layers'),0);
  assert.equal(filled.voxels.size,5);
  const match=makeMatcher(colors);
  for(let x=0;x<5;x++)assert.equal(filled.voxels.get(`${x},0,0`).colors[4].code,match(x===0?[20,100,30]:alphaPixels[x].slice(0,3)).code);
});
