import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {voxelize,buildPanels} from '../public/src/engine.js';
import {packPanels} from '../public/src/boards.js';
import {createTextureMapper} from '../public/src/color-matching.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const {PNG}=require(path.join(root,'vendor/node/pngjs'));
const catalog=JSON.parse(await fs.readFile(path.join(root,'public/data/catalog.json'),'utf8'));
const colors=JSON.parse(await fs.readFile(path.join(root,'public/data/palette.json'),'utf8')).colors;
const byCode=new Map(colors.map(color=>[color.code,color.hex.toUpperCase()]));
const originals={Image:globalThis.Image,document:globalThis.document};
const images=new Map();
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function image(url){if(!images.has(url))images.set(url,fs.readFile(path.join(root,'public',url)).then(bytes=>PNG.sync.read(bytes)));return images.get(url)}
before(()=>{
  globalThis.Image=class{set src(url){image(url).then(texture=>{this.fixture=texture;this.width=texture.width;this.height=texture.height;this.onload?.()},()=>this.onerror?.())}};
  globalThis.document={createElement(type){assert.equal(type,'canvas');let texture;return {getContext(){return {drawImage(value){texture=value.fixture},getImageData(){return {data:texture.data}}}}}}};
});
after(()=>{for(const [name,value]of Object.entries(originals)){if(value===undefined)delete globalThis[name];else globalThis[name]=value}});
async function input(key){const entry=catalog.entries.find(entry=>entry.key===key);assert.ok(entry,`Missing ${key}`);return {entry,model:JSON.parse(await fs.readFile(path.join(root,'public',entry.model),'utf8'))}}
function structuralSignature(data,result,boards){return sha({
  voxels:[...data.voxels.values()].map(voxel=>[voxel.p,voxel.preferredFace,voxel.colors.map(Boolean)]),
  panels:result.panels.map(panel=>[panel.id,panel.width,panel.height,panel.normal,panel.cells.map(cell=>[cell.p,cell.x,cell.y]),panel.slots]),
  seams:result.seams,
  boards:boards.map(board=>({placements:board.placements.map(placement=>[placement.panel.id,placement.x,placement.y]),unplaced:board.unplaced?.map(panel=>panel.id)})),
})}
function verifyManufacturingData(data,result,boards){
  const tally=new Map();
  for(const voxel of data.voxels.values())for(const color of voxel.colors.filter(Boolean))assert.equal(byCode.get(color.code),color.hex.toUpperCase(),`Unexpected model color ${color.code}/${color.hex}`);
  for(const cell of result.surface){assert.equal(byCode.get(cell.code),cell.hex.toUpperCase(),`Unexpected board color ${cell.code}/${cell.hex}`);tally.set(cell.code,(tally.get(cell.code)||0)+1)}
  assert.equal(new Set(result.surface.map(cell=>cell.p.join(','))).size,result.surface.length,'No duplicate physical beads');
  assert.equal(result.panels.reduce((sum,panel)=>sum+panel.cells.length,0),result.surface.length);
  assert.deepEqual([...tally].sort(),result.palette.map(color=>[color.code,color.count]).sort(),'Materials must count the exact displayed cells');
  let placed=0;
  for(const board of boards){
    assert.equal(board.unplaced?.length||0,0,'These representative models fit 52×52 boards');
    const positions=new Set();
    for(const placement of board.placements)for(const cell of placement.panel.cells){const x=placement.x+cell.x,y=placement.y+cell.y;assert.ok(x>=0&&y>=0&&x<52&&y<52);assert.ok(!positions.has(`${x},${y}`),'No overlapping board beads');positions.add(`${x},${y}`);placed++}
  }
  assert.equal(placed,result.surface.length,'Every bead is included on exactly one board');
}

test('real block and item textures preserve geometry, holes, board packing and exact materials across modes',async()=>{
  for(const key of ['block/grass_block','block/diamond_ore','item/diamond_sword']){
    const {entry,model}=await input(key);
    for(const scale of [1,2]){
      let baseline;
      for(const [colorMode,mix2x2]of [['legacy',false],['accurate',false],['detail',false],['detail',true]]){
        const data=await voxelize(model,entry,colors,scale,{colorMode,mix2x2});
        const result=buildPanels(data.voxels,{flat:data.flat}),boards=packPanels(result.panels,52);
        assert.ok(result.surface.length>0,`${key} has visible beads`);
        verifyManufacturingData(data,result,boards);
        const signature=structuralSignature(data,result,boards);
        if(baseline===undefined)baseline=signature;else assert.equal(signature,baseline,`${key} scale ${scale}: ${colorMode}/${mix2x2} changed geometry or packing`);
      }
    }
  }
});

test('mixing changes actual sub-beads at scale 2 while scale 1 remains an unmixed mapping',async()=>{
  const {entry,model}=await input('block/grass_block');
  const one=await voxelize(model,entry,colors,1,{colorMode:'detail',mix2x2:false});
  const oneMixed=await voxelize(model,entry,colors,1,{colorMode:'detail',mix2x2:true});
  assert.deepEqual([...one.voxels.values()].map(voxel=>voxel.colors),[...oneMixed.voxels.values()].map(voxel=>voxel.colors),'1× has no sub-beads to mix');
  const two=await voxelize(model,entry,colors,2,{colorMode:'detail',mix2x2:true});
  let mixed=0;
  for(let z=0;z<16;z++)for(let x=0;x<16;x++){
    const codes=new Set();
    for(let dz=0;dz<2;dz++)for(let dx=0;dx<2;dx++){const voxel=two.voxels.get(`${x*2+dx},31,${z*2+dz}`);assert.ok(voxel,'All four sub-beads remain present');assert.ok(voxel.colors[2],'Top colour remains defined');codes.add(voxel.colors[2].code)}
    if(codes.size>1)mixed++;
  }
  assert.ok(mixed>0,'2×2 option must use multiple real MARD beads inside at least one grass texel');
});

test('face-scoped detail mapping is unaffected by unrelated parts of a texture atlas',async()=>{
  const source=await image('/minecraft/textures/entity/creeper/creeper.png');
  const modified={width:source.width,height:source.height,data:Uint8ClampedArray.from(source.data)};
  for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++)if(x<8||x>=16||y<8||y>=16){const offset=(y*source.width+x)*4;modified.data.set([255,0,255,255],offset)}
  for(const mix2x2 of [false,true]){
    const a=createTextureMapper(source,colors,{mode:'detail',region:[8,8,16,16],mix2x2});
    const b=createTextureMapper(modified,colors,{mode:'detail',region:[8,8,16,16],mix2x2});
    for(let y=8;y<16;y++)for(let x=8;x<16;x++)for(let sy=0;sy<2;sy++)for(let sx=0;sx<2;sx++)assert.equal(a.sample(x,y,sx,sy)?.code,b.sample(x,y,sx,sy)?.code,`Atlas pixels outside the selected face changed ${x},${y}`);
  }
});

test('tripwire keeps legacy thin-face occupancy when snapped texels fall outside the face optimization region',async()=>{
  const {entry,model}=await input('block/tripwire');
  // The 0.5-wide wire snaps to one bead. Its sample centre can lie outside
  // the unsnapped box, making the rotated UV sample row 3 outside [0,2).
  // That row contains real alpha=107 pixels: region scoping may isolate
  // colour adjacency, but must not turn those existing beads transparent.
  for(const scale of [1,2]){
    let baseline;
    for(const [colorMode,mix2x2]of [['legacy',false],['accurate',false],['detail',false],['detail',true]]){
      const data=await voxelize(model,entry,colors,scale,{colorMode,mix2x2});
      assert.equal(data.voxels.size,scale===1?8:40,`${scale}× ${colorMode}/${mix2x2} retains the original texture-alpha occupancy`);
      const result=buildPanels(data.voxels,{flat:data.flat}),boards=packPanels(result.panels,52);
      verifyManufacturingData(data,result,boards);
      assert.ok(result.surface.length>0,'The wire must produce a visible pattern');
      const signature=structuralSignature(data,result,boards);
      if(baseline===undefined)baseline=signature;else assert.equal(signature,baseline,`${scale}× wire changes shape across colour modes`);
    }
  }
});
