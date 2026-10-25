import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createTextureMapper,rgbToLab,deltaE2000} from '../public/src/color-matching.js';
import {prepareDependencies} from './prepare-dependencies.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
await prepareDependencies({quiet:true});
function dependency(name){return require(path.join(root,'vendor/node',name))}
const {PNG}=dependency('pngjs');
const sharp=dependency('sharp');
const paletteBytes=await fs.readFile(path.join(root,'public/data/palette.json'));
const colors=JSON.parse(paletteBytes).colors;
const paletteCodes=new Set(colors.map(color=>color.code));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hexRgb=hex=>hex.match(/[a-f\d]{2}/gi).map(value=>parseInt(value,16));
const linear=value=>(value/=255)<=.04045?value/12.92:((value+.055)/1.055)**2.4;
const srgb=value=>255*(value<=.0031308?12.92*value:1.055*value**(1/2.4)-.055);
const mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0;
const round=value=>Number(value.toFixed(4));
const escape=value=>String(value).replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[character]));
const fixtures=[
  {id:'grass_block_top',label:'草方块顶面',file:'block/grass_block_top.png',tint:hexRgb('#7CBD6B').map(value=>value/255),region:[0,0,16,16],note:'原版默认草色 #7CBD6B'},
  {id:'dirt',label:'泥土',file:'block/dirt.png',region:[0,0,16,16],note:'原版无额外染色'},
  {id:'diamond_ore',label:'钻石矿石',file:'block/diamond_ore.png',region:[0,0,16,16],note:'原版无额外染色'},
  {id:'creeper_face',label:'苦力怕正脸',file:'entity/creeper/creeper.png',region:[8,8,16,16],note:'面部 UV [8,8,16,16]'},
];
const variants=[
  {id:'legacy',label:'旧版 Lab76',mode:'legacy',mix2x2:false},
  {id:'accurate',label:'CIEDE2000',mode:'accurate',mix2x2:false},
  {id:'detail',label:'纹理细节优先',mode:'detail',mix2x2:false},
  {id:'detail_mix2x2',label:'细节 + 2×2 混色',mode:'detail',mix2x2:true},
];
const rows=[];
for(const fixture of fixtures){
  const bytes=await fs.readFile(path.join(root,'public/minecraft/textures',fixture.file));
  const texture=PNG.sync.read(bytes),tint=fixture.tint||[1,1,1];
  const [x0,y0,x1,y1]=fixture.region,w=x1-x0,h=y1-y0;
  const source=[];
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
    const offset=(y*texture.width+x)*4;
    source.push({rgb:Array.from(texture.data.slice(offset,offset+3)).map((value,i)=>value*tint[i]),alpha:texture.data[offset+3],x,y});
  }
  const edges=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(const [dx,dy]of [[1,0],[0,1]]){
    if(x+dx>=w||y+dy>=h)continue;
    const a=y*w+x,b=(y+dy)*w+x+dx;
    if(!source[a].alpha||!source[b].alpha)continue;
    const contrast=deltaE2000(rgbToLab(source[a].rgb),rgbToLab(source[b].rgb));
    if(contrast>=5)edges.push({a,b,contrast});
  }
  const results=[];
  for(const variant of variants){
    const mapper=createTextureMapper(texture,colors,{tint,region:fixture.region,mode:variant.mode,mix2x2:variant.mix2x2});
    const codes=new Set(),appearance=[],beadDistances=[],appearanceDistances=[],grid=[];
    let mixedTexels=0;
    for(let i=0;i<source.length;i++){
      const pixel=source[i],subpixels=[];
      const subsize=variant.mix2x2?2:1;
      for(let subY=0;subY<subsize;subY++)for(let subX=0;subX<subsize;subX++){
        const color=mapper.sample(pixel.x,pixel.y,subX,subY);
        if(pixel.alpha&&(!color||!paletteCodes.has(color.code)))throw new Error(`${fixture.id}/${variant.id}: invalid palette cell`);
        subpixels.push(color);
        if(color){codes.add(color.code);beadDistances.push(deltaE2000(rgbToLab(pixel.rgb),rgbToLab(hexRgb(color.hex))))}
      }
      if(new Set(subpixels.filter(Boolean).map(color=>color.code)).size>1)mixedTexels++;
      const rgb=[0,1,2].map(channel=>srgb(mean(subpixels.filter(Boolean).map(color=>linear(hexRgb(color.hex)[channel])))));
      appearance.push(rgb);
      if(pixel.alpha)appearanceDistances.push(deltaE2000(rgbToLab(pixel.rgb),rgbToLab(rgb)));
      grid.push(subpixels);
    }
    const mappedEdges=edges.map(edge=>({...edge,mapped:deltaE2000(rgbToLab(appearance[edge.a]),rgbToLab(appearance[edge.b]))}));
    const lost=mappedEdges.filter(edge=>edge.mapped<Math.max(2,edge.contrast*.25)).length;
    results.push({...variant,grid,metrics:{
      meanDeltaE00:round(mean(appearanceDistances)),
      meanIndividualBeadDeltaE00:round(mean(beadDistances)),
      distinctMardCodes:codes.size,
      significantEdgeCount:edges.length,
      lostSignificantEdges:lost,
      lostSignificantEdgeRate:round(edges.length?lost/edges.length:0),
      meanSignificantEdgeContrastError:round(mean(mappedEdges.map(edge=>Math.abs(edge.mapped-edge.contrast)))),
      mixedTexels,
    },mapperStats:mapper.stats});
  }
  rows.push({...fixture,width:w,height:h,source,sourceSha256:sha(bytes),sourceDistinctRgb:new Set(source.filter(pixel=>pixel.alpha).map(pixel=>pixel.rgb.join(','))).size,results});
}

const output={
  schemaVersion:1,minecraftVersion:'Java 1.21.1',palette:'MARD 221',
  generatedAt:new Date().toISOString(),
  sourceHashes:{palette:sha(paletteBytes),colorMatching:sha(await fs.readFile(path.join(root,'public/src/color-matching.js')))},
  measurement:{
    display:'Unlit sRGB swatches. Source texture RGB is multiplied by the stated vanilla tint before matching.',
    meanDeltaE00:'Mean CIEDE2000 between each source texel and mapped appearance. For 2x2 only, appearance is the linear-light mean of its four actual MARD beads, converted back to sRGB.',
    meanIndividualBeadDeltaE00:'Mean CIEDE2000 over each physical bead separately; a spatial mixture can have larger per-bead error but smaller averaged-appearance error.',
    significantEdges:'Horizontal/vertical opaque source neighbours with source ΔE00 >= 5.',
    lostSignificantEdges:'Significant edges whose mapped ΔE00 is below max(2, 0.25 * source ΔE00).',
    meanSignificantEdgeContrastError:'Mean absolute error in ΔE00 contrast over significant source edges.',
    limits:'Four fixed real texture patches; this is not a proof for every Minecraft texture. sRGB swatches do not predict real bead reflectance, lighting, print profiles, or melting.',
  },
  fixtures:rows.map(({source,results,...row})=>({...row,results:results.map(({grid,...result})=>result)})),
};
const width=1440,height=1250,left=184,cellWidth=242,gridSize=190,top=142,rowHeight=250;
const svg=[`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  '<rect width="100%" height="100%" fill="#f8faf9"/>',
  '<style>text{font-family:"Microsoft YaHei",Arial,sans-serif;fill:#20382c} .small{font-size:12px;fill:#52665c}.metric{font-family:Consolas,monospace;font-size:12px}.heading{font-size:16px;font-weight:600}</style>',
  '<text x="32" y="43" font-size="25" font-weight="700">Minecraft → MARD 221：真实纹理配色对照</text>',
  '<text x="32" y="70" class="small">相同原版纹理、相同默认染色；所有色块均为无光照 sRGB，排除 3D 灯光影响。</text>',
  '<text x="32" y="92" class="small">ΔE00 衡量平均颜色误差；边缘指标只统计原图色差 ≥ 5 的相邻像素。</text>',
];
['原图 / 原版染色',...variants.map(variant=>variant.label)].forEach((label,column)=>svg.push(`<text x="${left+column*cellWidth}" y="122" class="heading">${escape(label)}</text>`));
for(const [rowIndex,row]of rows.entries()){
  const y=top+rowIndex*rowHeight;
  if(rowIndex)svg.push(`<line x1="28" y1="${y-10}" x2="1412" y2="${y-10}" stroke="#dde5e0"/>`);
  svg.push(`<text x="30" y="${y+22}" class="heading">${escape(row.label)}</text>`,`<text x="30" y="${y+45}" class="small">${row.width} × ${row.height} 像素</text>`,`<text x="30" y="${y+66}" class="small">${escape(row.id)}</text>`);
  const columns=[{source:true},...row.results];
  for(const [column,result]of columns.entries()){
    const x=left+column*cellWidth,size=result.mix2x2?2:1,peg=gridSize/(row.width*size);
    svg.push(`<rect x="${x}" y="${y}" width="${gridSize}" height="${gridSize}" fill="#fff" stroke="#a9bbb0"/>`);
    for(let py=0;py<row.height;py++)for(let px=0;px<row.width;px++){
      const index=py*row.width+px;
      for(let sy=0;sy<size;sy++)for(let sx=0;sx<size;sx++){
        const color=result.source?`rgb(${row.source[index].rgb.map(Math.round).join(',')})`:result.grid[index][sy*size+sx]?.hex;
        if(!color||!row.source[index].alpha)continue;
        svg.push(`<rect x="${x+(px*size+sx)*peg}" y="${y+(py*size+sy)*peg}" width="${peg}" height="${peg}" fill="${color}"/>`);
      }
    }
    if(result.source){svg.push(`<text x="${x}" y="${y+210}" class="metric">RGB colors: ${row.sourceDistinctRgb}</text>`,`<text x="${x}" y="${y+229}" class="small">${escape(row.note)}</text>`)}
    else {const m=result.metrics;svg.push(`<text x="${x}" y="${y+210}" class="metric">ΔE00 ${m.meanDeltaE00.toFixed(2)} · MARD ${m.distinctMardCodes}</text>`,`<text x="${x}" y="${y+229}" class="metric">Edge lost ${m.lostSignificantEdges}/${m.significantEdgeCount} · err ${m.meanSignificantEdgeContrastError.toFixed(2)}</text>`)}
  }
}
svg.push('<text x="32" y="1174" class="small">2×2 混色列显示四颗实际豆子；ΔE00 按四颗豆子的线性光均值计算，单颗误差另存 JSON。</text>',
  '<text x="32" y="1196" class="small">Edge lost：映射后边缘色差 &lt; max(2, 原色差 × 25%)；err：显著边缘色差的平均绝对误差。</text>',
  '<text x="32" y="1218" class="small">本图只比较四块固定纹理。实际豆子色差、反光、熨烫形变和显示器校准不在本次测量范围。</text>',
  '</svg>');
const directory=path.join(root,'docs');await fs.mkdir(directory,{recursive:true});
await fs.writeFile(path.join(directory,'color-comparison.json'),JSON.stringify(output,null,2)+'\n');
await fs.writeFile(path.join(directory,'color-comparison.svg'),svg.join('\n'));
await sharp(Buffer.from(svg.join('\n'))).png().toFile(path.join(directory,'color-comparison.png'));
console.log(JSON.stringify(output.fixtures.map(row=>({texture:row.id,results:row.results.map(result=>({mode:result.id,...result.metrics}))})),null,2));
console.log('Saved docs/color-comparison.json, .svg, and .png');
