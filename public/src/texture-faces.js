import {readTexture} from './engine.js';
import {createTextureMapper} from './color-matching.js';

const FACE_NAMES={up:'顶面',down:'底面',north:'北侧面',south:'南侧面',east:'东侧面',west:'西侧面'};
const FACE_ORDER={up:0,down:1,north:2,south:3,east:4,west:5};
const metadataCache=new Map();
const hexRgb=hex=>/^#[\da-f]{6}$/i.test(hex||'')?hex.slice(1).match(/../g).map(v=>parseInt(v,16)):null;

function textureUrl(value,model){
  const seen=new Set();
  while(typeof value==='string'&&value.startsWith('#')){
    if(seen.has(value))return null;
    seen.add(value);value=model.textures?.[value.slice(1)];
  }
  return typeof value==='string'&&!value.startsWith('#')?value:null;
}

function faceTint(face,entry){
  if(Array.isArray(face.tintRgb))return face.tintRgb.map(v=>Math.max(0,Math.min(255,Number(v)))/255);
  const explicit=hexRgb(face.tint)||hexRgb(entry.tint);
  if(explicit)return explicit.map(v=>v/255);
  if(face.tintindex===undefined)return [1,1,1];
  const id=(entry.id||'').replace(/^minecraft:/,'');
  // Vanilla 1.21.1 BlockColors defaults without a biome: GrassColor.get(.5,1)
  // is #7CBD6B in the bundled grass colormap; FoliageColor supplies the others.
  let hex;
  if(id==='spruce_leaves')hex='#619961';
  else if(id==='birch_leaves')hex='#80A755';
  else if(id.includes('leaves')||id==='vine')hex='#48B518';
  else if(id==='pink_petals'&&face.tintindex===0)return [1,1,1];
  else if(/grass|fern|pink_petals/.test(id))hex='#7CBD6B';
  else if(id==='water'||id==='bubble_column')hex='#3F76E4';
  else if(id==='lily_pad')hex='#208030';
  else if(id==='redstone_wire'){
    const power=Math.max(0,Math.min(15,Number(entry.properties?.power)||0)),f=power/15;
    return [power?f*.6+.4:.3,Math.max(0,f*f*.7-.5),Math.max(0,f*f*.6-.7)];
  }
  return hex?hexRgb(hex).map(v=>v/255):[1,1,1];
}

function collectFaces(model,entry){
  const geometryGroups=new Map();
  for(const element of model.elements||[])for(const [direction,face]of Object.entries(element.faces||{})){
    const texture=textureUrl(face.texture,model);if(!texture)continue;
    // Only genuinely coincident faces can be an overlay stack. Distinct UV
    // islands are not pasted over one another merely because they share a PNG.
    const geometryKey=JSON.stringify([direction,element.from,element.to,element.transform||null,
      element.rotation||null,element.blockstateRotation||null,face.uv||null,face.rotation||0]);
    let group=geometryGroups.get(geometryKey);
    if(!group){group={directions:[direction],layers:[]};geometryGroups.set(geometryKey,group);}
    const atlas=!/\/textures\/block\//.test(texture)&&(Boolean(model.textureSize)||/\/textures\/entity\//.test(texture));
    const layer={texture,tint:faceTint(face,entry),tintindex:face.tintindex,atlas,
      ...(atlas?{uv:face.uv||[0,0,model.textureSize?.[0]||16,model.textureSize?.[1]||16],rotation:((face.rotation||0)%360+360)%360}:{})};
    // Duplicate model elements with the same layer do not strengthen alpha.
    if(!group.layers.some(old=>JSON.stringify(old)===JSON.stringify(layer)))group.layers.push(layer);
  }
  if(!geometryGroups.size){
    const paths=model.layers?.length?model.layers:Object.keys(model.textures||{}).filter(k=>/^layer\d+$/.test(k)).sort().map(k=>model.textures[k]);
    if(paths?.length)geometryGroups.set('sprite',{directions:['texture'],layers:paths.map(value=>({texture:textureUrl(value,model),tint:[1,1,1]})).filter(x=>x.texture)});
  }
  const unique=new Map();
  for(const group of geometryGroups.values()){
    if(!group.layers.length)continue;
    // Whole textures are independent of element UV cropping and face rotation.
    const key=JSON.stringify(group.layers.map(({texture,tint,atlas,uv,rotation})=>({texture,tint,...(atlas?{uv,rotation}:{})})));
    if(!unique.has(key))unique.set(key,{...group,directions:new Set(),mergedFaceCount:0});
    const target=unique.get(key);group.directions.forEach(d=>target.directions.add(d));target.mergedFaceCount++;
  }
  return [...unique.values()].sort((a,b)=>Math.min(...[...a.directions].map(n=>FACE_ORDER[n]??6))-Math.min(...[...b.directions].map(n=>FACE_ORDER[n]??6)));
}

async function animationMetadata(url){
  if(!metadataCache.has(url))metadataCache.set(url,(async()=>{
    try{const response=await fetch(url+'.mcmeta');return response.ok?(await response.json()).animation:null;}catch{return null;}
  })());
  return metadataCache.get(url);
}

async function firstFrame(layer,model){
  const texture=await readTexture(layer.texture);
  if(layer.atlas){
    const textureSize=model.textureSize||[16,16];
    const uv=layer.uv.map((value,index)=>value*([texture.width,texture.height][index%2]/textureSize[index%2]));
    const sourceWidth=Math.max(1,Math.round(Math.abs(uv[2]-uv[0]))),sourceHeight=Math.max(1,Math.round(Math.abs(uv[3]-uv[1])));
    const turns=Math.round(layer.rotation/90)%4,swap=turns%2===1;
    const width=swap?sourceHeight:sourceWidth,height=swap?sourceWidth:sourceHeight;
    const data=new Uint8ClampedArray(width*height*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      let s=(x+.5)/width,t=(y+.5)/height;
      for(let turn=0;turn<turns;turn++)[s,t]=[t,1-s];
      const sx=Math.max(0,Math.min(texture.width-1,Math.floor(uv[0]+s*(uv[2]-uv[0]))));
      const sy=Math.max(0,Math.min(texture.height-1,Math.floor(uv[1]+t*(uv[3]-uv[1]))));
      data.set(texture.data.subarray((sy*texture.width+sx)*4,(sy*texture.width+sx)*4+4),(y*width+x)*4);
    }
    return {...layer,textureData:{width,height,data},width,height,x:0,y:0,
      metadata:{texture:layer.texture,kind:'atlas-crop',canvasWidth:texture.width,canvasHeight:texture.height,
        x:Math.floor(Math.min(uv[0],uv[2])),y:Math.floor(Math.min(uv[1],uv[3])),width:sourceWidth,height:sourceHeight,
        outputWidth:width,outputHeight:height,frameIndex:0,uv:layer.uv,textureSize,
        pixelRegion:[Math.min(uv[0],uv[2]),Math.min(uv[1],uv[3]),Math.max(uv[0],uv[2]),Math.max(uv[1],uv[3])],
        flipX:uv[2]<uv[0],flipY:uv[3]<uv[1],rotation:layer.rotation,sampling:'clamp-nearest'}};
  }
  let width=texture.width,height=texture.height,index=0;
  const isBlock=/\/textures\/block\//.test(layer.texture);
  if(isBlock&&!model.fullTexture&&height>width&&height%width===0){
    const animation=await animationMetadata(layer.texture);
    width=Math.max(1,Math.min(texture.width,Number(animation?.width)||texture.width));
    height=Math.max(1,Math.min(texture.height,Number(animation?.height)||width));
    const first=animation?.frames?.[0];
    index=Math.max(0,Math.floor(typeof first==='number'?first:Number(first?.index)||0));
    const count=Math.floor(texture.width/width)*Math.floor(texture.height/height);
    if(index>=count)index=0;
  }
  const columns=Math.max(1,Math.floor(texture.width/width));
  const x=(index%columns)*width,y=Math.floor(index/columns)*height;
  return {...layer,textureData:texture,width,height,x,y,
    metadata:{texture:layer.texture,kind:width!==texture.width||height!==texture.height?'animation-frame':'full-texture',
      canvasWidth:texture.width,canvasHeight:texture.height,x,y,width,height,outputWidth:width,outputHeight:height,frameIndex:index,
      pixelRegion:[x,y,x+width,y+height],flipX:false,flipY:false,rotation:0,sampling:'clamp-nearest'}};
}

function composite(frames){
  const width=Math.max(...frames.map(f=>f.width)),height=Math.max(...frames.map(f=>f.height));
  const data=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    let r=0,g=0,b=0,alpha=0;
    for(const frame of frames){
      const sx=frame.x+Math.min(frame.width-1,Math.floor(x*frame.width/width));
      const sy=frame.y+Math.min(frame.height-1,Math.floor(y*frame.height/height));
      const p=(sy*frame.textureData.width+sx)*4,source=frame.textureData.data,a=source[p+3]/255;
      if(!a)continue;
      const next=a+alpha*(1-a);
      r=(source[p]*frame.tint[0]*a+r*alpha*(1-a))/next;
      g=(source[p+1]*frame.tint[1]*a+g*alpha*(1-a))/next;
      b=(source[p+2]*frame.tint[2]*a+b*alpha*(1-a))/next;
      alpha=next;
    }
    data.set([r,g,b,alpha*255],(y*width+x)*4);
  }
  return {width,height,data};
}

function panelName(directions){
  if(['north','south','east','west'].every(d=>directions.includes(d))&&directions.length===4)return '侧面（四向相同）';
  if(directions.length===6)return '六面相同';
  return directions.map(d=>FACE_NAMES[d]||'完整纹理').join(' / ');
}

/** Complete, deduplicated source-texture canvases, with no assembly slots. */
export async function buildTextureFaces(model,entry,colors,scale=1,options={}){
  if(!Number.isInteger(scale)||scale<1||scale>8)throw new RangeError('纹理倍率必须是 1–8 的整数');
  const settings={mode:['detail','accurate','legacy'].includes(options.colorMode)?options.colorMode:'detail',
    mix2x2:Boolean(options.mix2x2&&scale===2),fillTransparent:Boolean(options.fillTransparent),scale};
  const groups=collectFaces(model,entry),panels=[],warnings=[];
  if(!groups.length)return {patternMode:'faces',flat:true,panels,seams:[],surface:[],palette:[],warnings:['此模型没有可读取的原始纹理面。'],colorSettings:settings};
  for(const group of groups){
    const frames=await Promise.all(group.layers.map(layer=>firstFrame(layer,model)));
    const texture=composite(frames);
    const mapper=createTextureMapper(texture,colors,{region:[0,0,texture.width,texture.height],mode:settings.mode,
      mix2x2:settings.mix2x2,fillTransparent:settings.fillTransparent});
    const id='P'+String(panels.length+1).padStart(2,'0'),directions=[...group.directions].sort((a,b)=>(FACE_ORDER[a]??6)-(FACE_ORDER[b]??6));
    const panel={id,name:panelName(directions),width:texture.width*scale,height:texture.height*scale,cells:[],
      normal:[0,0,1],u:[1,0,0],v:[0,-1,0],plane:0,slots:[],seams:[],directions,
      sourceTextures:frames.map(f=>f.texture),sourceSize:[texture.width,texture.height],sourceFrames:frames.map(f=>f.metadata),
      mergedFaceCount:group.mergedFaceCount,sourceTints:frames.map(f=>f.tint),colorStats:mapper.stats};
    for(let y=0;y<panel.height;y++)for(let x=0;x<panel.width;x++){
      const color=mapper.sample(Math.floor(x/scale),Math.floor(y/scale),settings.mix2x2?x%2:0,settings.mix2x2?y%2:0);
      if(!color)continue;
      panel.cells.push({x,y,code:color.code,hex:color.hex,transparent:Boolean(color.transparent),face:4,slot:false,panelId:id});
    }
    if(frames.some(f=>f.metadata.kind==='animation-frame'))panel.note='动画取首帧完整画布。';
    if(frames.some(f=>f.atlas)){
      panel.note=`图集按原始面 UV 提取 ${texture.width}×${texture.height} 像素完整面；保留透明边缘，不添加拼插孔。`;
      warnings.push(panel.note);
    }else if(texture.width!==16||texture.height!==16){
      panel.note=`保留原始 ${texture.width}×${texture.height} 像素完整纹理；不强行缩放到 16×16。`;
      warnings.push(panel.note);
    }
    if(frames.some(f=>f.width!==texture.width||f.height!==texture.height))warnings.push('部分叠层分辨率不同，按最高分辨率完整画布对齐。');
    panels.push(panel);
  }
  const columns=Math.ceil(Math.sqrt(panels.length));
  const columnWidth=Math.max(...panels.map(p=>p.width))+6,rowHeight=Math.max(...panels.map(p=>p.height))+6;
  const surface=[],palette=new Map();
  panels.forEach((panel,index)=>{
    const ox=index%columns*columnWidth,oy=Math.floor(index/columns)*rowHeight;
    panel.displayOrigin=[ox,-oy,0];
    for(const cell of panel.cells){
      cell.p=[ox+cell.x,-oy-cell.y,0];cell.gx=cell.p[0];cell.gy=-cell.p[1];surface.push(cell);
      const key=cell.code+':'+Number(cell.transparent);
      if(!palette.has(key))palette.set(key,{code:cell.code,hex:cell.hex,transparent:cell.transparent,count:0});
      palette.get(key).count++;
    }
  });
  if(panels.some(p=>p.width>52||p.height>52))warnings.push('完整纹理超过 52×52 豆板；保留原尺寸，需更大豆板。');
  if(groups.some(g=>g.layers.some(l=>l.tintindex!==undefined)))warnings.push('染色纹理采用明确色值或原版默认颜色；实际群系颜色可能不同。');
  return {patternMode:'faces',flat:true,panels,seams:[],surface,palette:[...palette.values()].sort((a,b)=>b.count-a.count||a.code.localeCompare(b.code)),
    warnings:[...new Set(warnings)],colorSettings:{...settings,algorithm:settings.mode==='legacy'?'CIE76':'CIEDE2000',revision:2},
    sourceModel:model.sourceModel||entry.id,needsStructureReview:false};
}
