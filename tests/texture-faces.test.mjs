import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {buildTextureFaces} from '../public/src/texture-faces.js';
import {packPanels} from '../public/src/boards.js';

const fixtures=new Map();let nextId=0;
const oldImage=globalThis.Image,oldDocument=globalThis.document,oldFetch=globalThis.fetch;
const palette=[{code:'R',hex:'#FF0000'},{code:'G',hex:'#00FF00'},{code:'B',hex:'#0000FF'},
  {code:'DIRT',hex:'#804020'},{code:'W',hex:'#FFFFFF'},{code:'H01',hex:'#E9F1EE',transparent:true}];
before(()=>{
  globalThis.Image=class{set src(url){this.fixture=fixtures.get(url);if(!this.fixture)return queueMicrotask(()=>this.onerror?.());this.width=this.fixture.width;this.height=this.fixture.height;queueMicrotask(()=>this.onload?.());}};
  globalThis.document={createElement(name){assert.equal(name,'canvas');let fixture;return{getContext(){return{drawImage(image){fixture=image.fixture},getImageData(){return{data:fixture.data}}}}}}};
  globalThis.fetch=async url=>{const animation=fixtures.get(String(url).replace(/\.mcmeta$/,''))?.animation;return{ok:Boolean(animation),json:async()=>({animation})}};
});
after(()=>{
  if(oldImage===undefined)delete globalThis.Image;else globalThis.Image=oldImage;
  if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
  if(oldFetch===undefined)delete globalThis.fetch;else globalThis.fetch=oldFetch;
});

function texture(width,height,pixels,{category='block',animation}={}){
  const url=`/minecraft/textures/${category}/texture-faces-test-${nextId++}.png`;
  const values=typeof pixels==='function'?Array.from({length:width*height},(_,i)=>pixels(i%width,Math.floor(i/width))):pixels;
  fixtures.set(url,{width,height,data:Uint8ClampedArray.from(values.flat()),animation});return url;
}
const solid=(w,h,rgba,options)=>texture(w,h,()=>rgba,options);
function cube(faces){return{from:[0,0,0],to:[16,16,16],faces};}
const allFaces=url=>Object.fromEntries(['up','down','north','south','east','west'].map(direction=>[direction,{texture:url}]));

test('grass yields three complete 16x16 canvases and composites the tinted side overlay before deduplication',async()=>{
  const dirt=solid(16,16,[128,64,32,255]),top=solid(16,16,[255,255,255,255]);
  const side=solid(16,16,[128,64,32,255]);
  const overlay=texture(16,16,(_x,y)=>[255,255,255,y<3?255:0]);
  const base=allFaces(side);base.up={texture:top,tintRgb:[0,255,0]};base.down={texture:dirt};
  const overlayFaces=Object.fromEntries(['north','south','east','west'].map(direction=>[direction,{texture:overlay,tintRgb:[0,255,0]}]));
  const model={elements:[cube(base),cube(overlayFaces)]};
  const result=await buildTextureFaces(model,{id:'minecraft:grass_block'},palette,1,{colorMode:'accurate',fillTransparent:true});
  assert.equal(result.patternMode,'faces');assert.equal(result.flat,true);assert.equal(result.panels.length,3);
  const sidePanel=result.panels.find(p=>p.directions.length===4);
  assert.equal(sidePanel.mergedFaceCount,4);
  assert.deepEqual(sidePanel.sourceTextures,[side,overlay]);
  for(const panel of result.panels){
    assert.equal(panel.width,16);assert.equal(panel.height,16);assert.equal(panel.cells.length,256);
    assert.deepEqual(panel.slots,[]);assert.deepEqual(panel.seams,[]);assert.deepEqual(panel.normal,[0,0,1]);
    assert.ok(panel.cells.every(c=>!c.slot&&!c.hole&&!c.transparent));
    for(const [x,y]of [[0,0],[15,0],[0,15],[15,15]])assert.ok(panel.cells.some(c=>c.x===x&&c.y===y));
  }
  assert.ok(sidePanel.cells.filter(c=>c.y<3).every(c=>c.code==='G'));
  assert.ok(sidePanel.cells.filter(c=>c.y>=3).every(c=>c.code==='DIRT'));
  assert.equal(result.surface.length,768);assert.equal(result.palette.reduce((sum,c)=>sum+c.count,0),768);
  assert.equal(new Set(result.surface.map(c=>c.p.join(','))).size,768,'gallery planes cannot overlap');
  assert.deepEqual(result.seams,[]);
  assert.equal(packPanels(result.panels,52).flatMap(b=>b.placements).length,3);
});

test('source URL and tint distinguish faces; cropped UVs and rotated uses of one texture merge',async()=>{
  const url=texture(16,16,(x,y)=>x===0?[255,0,0,255]:x===15?[0,0,255,255]:y===0?[0,255,0,255]:[255,255,255,255]);
  const model={elements:[cube({north:{texture:url,uv:[4,4,12,12]},south:{texture:url,uv:[0,0,16,16],rotation:90}})]};
  const result=await buildTextureFaces(model,{id:'test:stairs'},palette,1,{colorMode:'accurate'});
  assert.equal(result.panels.length,1);const panel=result.panels[0];assert.equal(panel.mergedFaceCount,2);
  assert.equal(panel.cells.find(c=>c.x===0&&c.y===8).code,'R');
  assert.equal(panel.cells.find(c=>c.x===15&&c.y===8).code,'B');
  assert.equal(panel.cells.find(c=>c.x===8&&c.y===0).code,'G');
  const white=solid(16,16,[255,255,255,255]);
  const tinted=await buildTextureFaces({elements:[cube({up:{texture:white,tintRgb:[255,0,0]},down:{texture:white,tintRgb:[0,255,0]}})]},{id:'test:tint'},palette,1,{colorMode:'accurate'});
  assert.equal(tinted.panels.length,2);
  assert.deepEqual(tinted.panels.map(p=>p.cells[0].code),['R','G']);
});

test('transparent margins retain original canvas size and optional H01 fills them without creating slots',async()=>{
  const url=texture(16,16,(x,y)=>[255,0,0,x>=6&&x<10&&y>=6&&y<10?255:0]);
  const model={elements:[cube(allFaces(url))]};
  const empty=await buildTextureFaces(model,{id:'test:transparent'},palette,1,{colorMode:'accurate'});
  assert.equal(empty.panels[0].width,16);assert.equal(empty.panels[0].height,16);
  assert.equal(empty.panels[0].cells.length,16);assert.equal(Math.min(...empty.panels[0].cells.map(c=>c.x)),6);
  const filled=await buildTextureFaces(model,{id:'test:transparent'},palette,1,{colorMode:'accurate',fillTransparent:true});
  assert.equal(filled.panels[0].cells.length,256);
  const h01=filled.palette.find(c=>c.code==='H01');assert.equal(h01.count,240);assert.equal(h01.transparent,true);
  assert.equal(filled.surface.filter(c=>c.transparent&&c.code==='H01').length,240);
  assert.ok(filled.surface.every(c=>c.slot===false));assert.deepEqual(filled.panels[0].slots,[]);
});

test('2x2 mixing follows source pixel phase and never leaks into its neighbour',async()=>{
  const colors=[{code:'A',hex:'#647A64'},{code:'B',hex:'#7E967E'},{code:'BLACK',hex:'#000000'},{code:'H01',hex:'#FFFFFF',transparent:true}];
  const url=texture(2,1,[[114,138,114,255],[0,0,0,255]]);
  const result=await buildTextureFaces({elements:[cube({north:{texture:url}})]},{id:'test:mixed'},colors,2,{colorMode:'accurate',mix2x2:true});
  const panel=result.panels[0];assert.equal(panel.width,4);assert.equal(panel.height,2);
  assert.equal(new Set(panel.cells.filter(c=>c.x<2).map(c=>c.code)).size,2);
  assert.ok(panel.cells.filter(c=>c.x>=2).every(c=>c.code==='BLACK'));
  assert.equal(result.colorSettings.mix2x2,true);
  const single=await buildTextureFaces({elements:[cube({north:{texture:url}})]},{id:'test:mixed'},colors,1,{colorMode:'accurate',mix2x2:true});
  assert.equal(single.colorSettings.mix2x2,false);
});

test('animated block PNGs use the metadata first frame; atlas faces retain their distinct original UV rectangles',async()=>{
  const animated=texture(16,32,(_x,y)=>y<16?[255,0,0,255]:[0,0,255,255],{animation:{frames:[1,0]}});
  const animation=await buildTextureFaces({elements:[cube(allFaces(animated))]},{id:'test:animated'},palette,1,{colorMode:'accurate'});
  assert.deepEqual(animation.panels[0].sourceSize,[16,16]);
  assert.equal(animation.panels[0].sourceFrames[0].canvasHeight,32);
  assert.equal(animation.panels[0].sourceFrames[0].frameIndex,1);
  assert.ok(animation.surface.every(c=>c.code==='B'));
  const atlas=texture(64,32,(x,y)=>x>=14&&x<28&&y>=14&&y<28?[0,0,255,255]:[255,0,0,255],{category:'entity/chest'});
  const special=await buildTextureFaces({textureSize:[64,32],elements:[cube({up:{texture:atlas,uv:[0,0,14,14]},down:{texture:atlas,uv:[14,14,28,28]}})]},{id:'minecraft:chest'},palette);
  assert.equal(special.panels.length,2);
  assert.deepEqual(special.panels.map(p=>p.sourceSize),[[14,14],[14,14]]);
  assert.equal(special.panels[0].cells.length,196);assert.equal(special.panels[1].cells.length,196);
  assert.ok(special.panels[0].cells.every(c=>c.code==='R'));assert.ok(special.panels[1].cells.every(c=>c.code==='B'));
  assert.deepEqual(special.panels[1].sourceFrames[0].pixelRegion,[14,14,28,28]);
  assert.equal(special.panels[0].sourceFrames[0].canvasWidth,64);assert.equal(special.panels[0].sourceFrames[0].canvasHeight,32);
  assert.equal(special.panels[0].sourceFrames[0].kind,'atlas-crop');
  assert.ok(special.warnings.some(w=>w.includes('14×14')));
});

test('atlas crops honor UV mirroring and rotations while preserving clear edge texels',async()=>{
  const atlas=texture(4,2,[[255,0,0,0],[255,0,0,255],[0,255,0,255],[0,0,255,255],
    [255,0,0,0],[0,0,255,255],[255,255,255,255],[0,255,0,255]],{category:'entity/test'});
  const model={textureSize:[4,2],elements:[cube({north:{texture:atlas,uv:[0,0,4,2]},south:{texture:atlas,uv:[4,0,0,2]},east:{texture:atlas,uv:[0,0,4,2],rotation:90}})]};
  const result=await buildTextureFaces(model,{id:'test:atlas'},palette,1,{colorMode:'accurate',fillTransparent:true});
  assert.equal(result.panels.length,3);
  const [plain,mirror,rotated]=result.panels;
  assert.deepEqual(plain.sourceSize,[4,2]);assert.deepEqual(rotated.sourceSize,[2,4]);
  assert.ok(plain.cells.filter(c=>c.x===0).every(c=>c.transparent));
  assert.ok(mirror.cells.filter(c=>c.x===3).every(c=>c.transparent));
  assert.ok(rotated.cells.filter(c=>c.y===0).every(c=>c.transparent));
  assert.equal(mirror.sourceFrames[0].flipX,true);assert.equal(rotated.sourceFrames[0].rotation,90);
  assert.deepEqual([rotated.sourceFrames[0].width,rotated.sourceFrames[0].height],[4,2]);
  assert.deepEqual([rotated.sourceFrames[0].outputWidth,rotated.sourceFrames[0].outputHeight],[2,4]);
});

test('all-transparent images still retain a panel and full-color fill is separate from normal palette matching',async()=>{
  const url=solid(4,4,[0,0,0,0]);
  const model={elements:[cube({south:{texture:url}})]};
  const result=await buildTextureFaces(model,{id:'test:clear'},palette);
  assert.equal(result.panels.length,1);assert.deepEqual(result.panels[0].sourceSize,[4,4]);assert.equal(result.surface.length,0);
  const fill=await buildTextureFaces(model,{id:'test:clear'},palette,1,{fillTransparent:true});
  assert.equal(fill.surface.length,16);assert.equal(fill.palette.length,1);assert.equal(fill.palette[0].code,'H01');
});
