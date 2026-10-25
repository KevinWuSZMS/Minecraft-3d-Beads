import {Matrix4, Vector3} from 'three';

export const DIRECTIONS=[
  {name:'east',label:'右面',n:[1,0,0],u:[0,0,-1],v:[0,-1,0]},
  {name:'west',label:'左面',n:[-1,0,0],u:[0,0,1],v:[0,-1,0]},
  {name:'up',label:'顶面',n:[0,1,0],u:[1,0,0],v:[0,0,1]},
  {name:'down',label:'底面',n:[0,-1,0],u:[1,0,0],v:[0,0,-1]},
  {name:'south',label:'前面',n:[0,0,1],u:[1,0,0],v:[0,-1,0]},
  {name:'north',label:'后面',n:[0,0,-1],u:[-1,0,0],v:[0,-1,0]}
];
const key=p=>p.join(',');
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
export {rgbToLab, makeMatcher} from './color-matching.js';
import {createTextureMapper} from './color-matching.js';
const textures=new Map();
export async function readTexture(url){if(textures.has(url))return textures.get(url);const p=new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>{const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0);resolve({width:c.width,height:c.height,data:ctx.getImageData(0,0,c.width,c.height).data})};img.onerror=()=>reject(new Error('纹理无法读取：'+url));img.src=url});textures.set(url,p);return p;}
function pixel(tex,x,y){x=Math.min(tex.width-1,Math.max(0,Math.floor(x)));y=Math.min(tex.height-1,Math.max(0,Math.floor(y)));const i=(y*tex.width+x)*4;return Array.from(tex.data.slice(i,i+4));}
function defaultUV(face,a,b){switch(face){case 'north':return [16-b[0],16-b[1],16-a[0],16-a[1]];case 'south':return [a[0],16-b[1],b[0],16-a[1]];case 'west':return [a[2],16-b[1],b[2],16-a[1]];case 'east':return [16-b[2],16-b[1],16-a[2],16-a[1]];case 'up':return [a[0],a[2],b[0],b[2]];default:return [a[0],16-b[2],b[0],16-a[2]];}}
function faceST(name,p,a,b){const q=p.map((v,i)=>(v-a[i])/Math.max(.001,b[i]-a[i]));switch(name){case 'north':return [1-q[0],1-q[1]];case 'south':return [q[0],1-q[1]];case 'east':return [1-q[2],1-q[1]];case 'west':return [q[2],1-q[1]];case 'up':return [q[0],q[2]];default:return [q[0],1-q[2]];}}
export function elementMatrix(el){const m=el.transform?new Matrix4().fromArray(el.transform):new Matrix4();if(el.rotation){const {origin=[8,8,8],axis='y',angle=0,rescale=false}=el.rotation;const r=new Matrix4()[{x:'makeRotationX',y:'makeRotationY',z:'makeRotationZ'}[axis]](angle*Math.PI/180);m.makeTranslation(...origin).multiply(r);if(rescale){const s=[1,1,1].map((_,i)=>'xyz'[i]===axis?1:1/Math.cos(angle*Math.PI/180));m.scale(new Vector3(...s))}m.multiply(new Matrix4().makeTranslation(...origin.map(x=>-x)))}if(el.blockstateRotation){const {x=0,y=0}=el.blockstateRotation;const state=new Matrix4().makeTranslation(8,8,8).multiply(new Matrix4().makeRotationY(-y*Math.PI/180)).multiply(new Matrix4().makeRotationX(-x*Math.PI/180)).multiply(new Matrix4().makeTranslation(-8,-8,-8));m.premultiply(state)}return m;}

// A mapper is prepared per source face, before spatial sampling. Atlas faces
// are separate regions, so neighbouring UV islands never change each other's palette.
function faceSampler(faceName, face, from, to, model, texture, colors, settings) {
  const uv = face.uv || defaultUV(faceName, from, to);
  const xUnit = texture.width / (model.textureSize?.[0] || 16);
  const frameHeight = Math.min(texture.height, model.textureSize ? texture.height : texture.width);
  const yUnit = frameHeight / (model.textureSize?.[1] || 16);
  const tint = face.tintRgb ? face.tintRgb.map(value => value / 255)
    : face.tint ? face.tint.match(/[a-f0-9]{2}/gi).map(value => parseInt(value, 16) / 255) : [1, 1, 1];
  const region = [
    Math.floor(Math.min(uv[0], uv[2]) * xUnit),
    Math.floor(Math.min(uv[1], uv[3]) * yUnit),
    Math.ceil(Math.max(uv[0], uv[2]) * xUnit),
    Math.ceil(Math.max(uv[1], uv[3]) * yUnit),
  ];
  const mapper = createTextureMapper(texture, colors, {
    tint, region, mode: settings.mode, mix2x2: settings.mix2x2, fillTransparent: settings.fillTransparent,
  });
  return local => {
    let [s, t] = faceST(faceName, local, from, to);
    for (let i = 0; i < (face.rotation || 0) / 90; i++) [s, t] = [t, 1 - s];
    const px = Math.max(0, Math.min(texture.width - 1e-6, (uv[0] + s * (uv[2] - uv[0])) * xUnit));
    const py = Math.max(0, Math.min(frameHeight - 1e-6, (uv[1] + t * (uv[3] - uv[1])) * yUnit));
    // Subcell phase comes from the original texture, not board packing, part
    // orientation, or world coordinates. Repacking cannot change bead colours.
    const sx = settings.mix2x2 ? Math.min(1, Math.floor((px - Math.floor(px)) * 2)) : 0;
    const sy = settings.mix2x2 ? Math.min(1, Math.floor((py - Math.floor(py)) * 2)) : 0;
    const tx = Math.floor(px), ty = Math.floor(py);
    const [x0, y0, x1, y1] = mapper.stats.region;
    // Snapping sub-bead-thin elements can put a sample beyond its UV rectangle.
    // Keep that established texture sample/opacity, but do not add unrelated
    // atlas pixels to this face's contrast neighbourhood.
    if (tx < x0 || ty < y0 || tx >= x1 || ty >= y1) {
      return createTextureMapper(texture, colors, {tint, region: [tx, ty, tx + 1, ty + 1],
        mode: settings.mode === 'legacy' ? 'legacy' : 'accurate', mix2x2: settings.mix2x2,
        fillTransparent: settings.fillTransparent}).sample(tx, ty, sx, sy);
    }
    return mapper.sample(tx, ty, sx, sy);
  };
}

export async function voxelize(model, entry, colors, scale = 1, options = {}) {
  const settings = {
    mode: ['detail', 'accurate', 'legacy'].includes(options.colorMode) ? options.colorMode : 'detail',
    mix2x2: Boolean(options.mix2x2 && scale === 2),
    fillTransparent: Boolean(options.fillTransparent),
  };
  const voxels = new Map();
  const warnings = [];
  const layerPaths = model.layers || Object.keys(model.textures || {}).filter(x => /^layer\d+$/.test(x)).sort().map(x => model.textures[x]);
  if (!model.elements?.length && layerPaths.length) {
    const layers = await Promise.all((entry.thumbnail ? [entry.thumbnail] : layerPaths).map(readTexture));
    const w = layers[0].width, h = model.fullTexture ? layers[0].height : Math.min(layers[0].height, w);
    let texture = layers[0];
    if (layers.length > 1) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        for (const layer of layers) {
          const rgba = pixel(layer, x, y);
          if (rgba[3] > 0) data.set(rgba, (y * w + x) * 4);
        }
      }
      texture = {width: w, height: h, data};
    }
    const mapper = createTextureMapper(texture, colors, {region: [0, 0, w, h], mode: settings.mode,
      mix2x2: settings.mix2x2, fillTransparent: settings.fillTransparent});
    for (let y = 0; y < h * scale; y++) for (let x = 0; x < w * scale; x++) {
      const tx = Math.floor(x / scale), ty = Math.floor(y / scale);
      const alpha = texture.data[(ty * texture.width + tx) * 4 + 3];
      if (alpha === 0 && !settings.fillTransparent) continue;
      const color = mapper.sample(tx, ty, settings.mix2x2 ? x % 2 : 0, settings.mix2x2 ? y % 2 : 0);
      if (!color) continue;
      const p = [x, h * scale - 1 - y, 0];
      voxels.set(key(p), {p, colors: Array(6).fill(color)});
    }
    return {voxels, warnings, flat: true, colorSettings: settings};
  }
  if (!model.elements?.length) return {voxels, warnings: ['此对象没有可提取的实体表面。'], flat: false, colorSettings: settings};
  const urls = [...new Set(model.elements.flatMap(el => Object.values(el.faces || {}).map(f => f.texture)).filter(x => typeof x === 'string' && !x.startsWith('#')))];
  const loaded = new Map(await Promise.all(urls.map(async url => [url, await readTexture(url)])));
  for (const el of model.elements) {
    if (!el.from || !el.to) continue;
    const a = el.from.map((x, i) => Math.min(x, el.to[i])), b = el.from.map((x, i) => Math.max(x, el.to[i]));
    const thin = b.map((x, i) => x - a[i] <= 1);
    const aa = a.map((x, i) => thin[i] ? Math.floor(x) : x), bb = b.map((x, i) => thin[i] ? Math.floor(a[i]) + 1 : x);
    const m = elementMatrix({...el, blockstateRotation: el.blockstateRotation || model.blockstateRotation});
    const inv = m.clone().invert();
    const narrowAxis = b.findIndex((v, i) => v - a[i] <= 1.01);
    let preferredFace;
    if (narrowAxis >= 0) {
      const axis = [0, 0, 0]; axis[narrowAxis] = 1;
      const n = new Vector3(...axis).transformDirection(m);
      let best = -Infinity;
      DIRECTIONS.forEach((d, i) => {const score = n.dot(new Vector3(...d.n)); if (score > best) {best = score; preferredFace = i;}});
    }
    const samplers = new Map(Object.entries(el.faces || {}).filter(([, face]) => loaded.has(face.texture))
      .map(([name, face]) => [name, faceSampler(name, face, a, b, model, loaded.get(face.texture), colors, settings)]));
    const worldSamplers = DIRECTIONS.map(dir => {
      const n = new Vector3(...dir.n).transformDirection(inv);
      let chosen = 0, best = -Infinity;
      DIRECTIONS.forEach((d, i) => {const score = n.dot(new Vector3(...d.n)); if (score > best) {best = score; chosen = i;}});
      return samplers.get(DIRECTIONS[chosen].name);
    });
    const corners = [];
    for (let i = 0; i < 8; i++) corners.push(new Vector3(...aa.map((v, j) => i & (1 << j) ? bb[j] : v)).applyMatrix4(m));
    const min = [0, 1, 2].map(i => Math.floor(Math.min(...corners.map(v => v.getComponent(i))) * scale + 1e-5));
    const max = [0, 1, 2].map(i => Math.ceil(Math.max(...corners.map(v => v.getComponent(i))) * scale - 1e-5));
    if ((max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]) > 1500000) throw new Error('模型体积过大，请使用 1 倍像素尺寸。');
    for (let x = min[0]; x < max[0]; x++) for (let y = min[1]; y < max[1]; y++) for (let z = min[2]; z < max[2]; z++) {
      const p = [x, y, z];
      const local = new Vector3((x + .5) / scale, (y + .5) / scale, (z + .5) / scale).applyMatrix4(inv).toArray();
      if (local.some((v, i) => v < aa[i] - .001 || v >= bb[i] - .00001)) continue;
      const colorFaces = worldSamplers.map(sample => sample ? sample(local) : null);
      if (thin.some(Boolean) && colorFaces.every(x => !x)) continue;
      const previous = voxels.get(key(p));
      voxels.set(key(p), {p, preferredFace: previous ? previous.preferredFace : preferredFace,
        // Clear overlay pixels must not replace the opaque base texture.
        colors: colorFaces.map((c, i) => c?.transparent && previous?.colors[i]
          ? previous.colors[i] : c || previous?.colors[i] || null)});
    }
  }
  if (model.elements.some(x => x.rotation || x.transform?.some((v, i) => [0, 1, 2, 4, 5, 6, 8, 9, 10].includes(i) && Math.abs(v) > .0001 && Math.abs(v) < .9999))) warnings.push('旋转部件已按豆子网格体素化；斜面会呈阶梯状。');
  return {voxels, warnings, flat: false, colorSettings: settings};
}

export function buildPanels(voxels,{flat=false,pitch=3}={}){const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];for(const v of voxels.values())v.p.forEach((n,i)=>{lo[i]=Math.min(lo[i],n);hi[i]=Math.max(hi[i],n)});const thinAxis=hi.findIndex((v,i)=>v-lo[i]<1);const flatDirection=flat?4:thinAxis>=0?thinAxis*2:-1;const groups=new Map(),surface=[];for(const voxel of voxels.values()){const exposed=DIRECTIONS.map((d,i)=>!voxels.has(key(voxel.p.map((v,j)=>v+d.n[j])))?i:-1).filter(i=>i>=0);if(!exposed.length)continue;let selected;
    if(flatDirection>=0)selected=flatDirection;else if(voxel.preferredFace!==undefined)selected=voxel.preferredFace;else{const unique=exposed.filter((v,i)=>exposed.findIndex(n=>Math.floor(n/2)===Math.floor(v/2))===i);if(unique.length===1)selected=unique[0];else if(unique.length===2){const axes=unique.map(i=>Math.floor(i/2));const shared=[0,1,2].find(x=>!axes.includes(x));selected=unique[((Math.floor(voxel.p[shared]/pitch)%2)+2)%2]}else selected=unique[0];}
    const dir=DIRECTIONS[selected],plane=dot(voxel.p,dir.n),gkey=selected+':'+plane;const col=voxel.colors[selected]||(voxel.preferredFace!==undefined?voxel.colors.find(Boolean):null);if(!col)continue;const cell={p:voxel.p,code:col.code,hex:col.hex,transparent:Boolean(col.transparent),face:selected,slot:exposed.length>1};if(!groups.has(gkey))groups.set(gkey,{dir,plane,cells:[]});groups.get(gkey).cells.push(cell);surface.push(cell);
  }
  const panels=[];for(const group of groups.values()){const all=new Map(group.cells.map(c=>{c.gx=dot(c.p,group.dir.u);c.gy=dot(c.p,group.dir.v);return [c.gx+','+c.gy,c]}));while(all.size){const seed=all.values().next().value;const stack=[seed],component=[];all.delete(seed.gx+','+seed.gy);while(stack.length){const c=stack.pop();component.push(c);for(const [dx,dy]of [[1,0],[-1,0],[0,1],[0,-1]]){const k=(c.gx+dx)+','+(c.gy+dy);if(all.has(k)){stack.push(all.get(k));all.delete(k)}}}const minX=Math.min(...component.map(c=>c.gx)),minY=Math.min(...component.map(c=>c.gy));const id='P'+String(panels.length+1).padStart(2,'0');component.forEach(c=>{c.x=c.gx-minX;c.y=c.gy-minY;c.panelId=id});panels.push({id,name:group.dir.label,width:Math.max(...component.map(c=>c.x))+1,height:Math.max(...component.map(c=>c.y))+1,cells:component,normal:group.dir.n,u:group.dir.u,v:group.dir.v,plane:group.plane});}}
  let parallelContacts=false;const cellMap=new Map(surface.map(c=>[key(c.p),c])),contacts=new Map();for(const c of surface)for(const d of DIRECTIONS){const other=cellMap.get(key(c.p.map((v,i)=>v+d.n[i])));if(!other||other.panelId===c.panelId)continue;if(Math.floor(c.face/2)===Math.floor(other.face/2)){parallelContacts=true;continue}const ids=[c.panelId,other.panelId].sort(),k=ids.join(':');if(!contacts.has(k))contacts.set(k,{panels:ids,count:0});contacts.get(k).count++;}
  // A slot is a missing edge cell occupied by a perpendicular neighbour panel.
  // Keep these markers separate from real beads so materials and 3D counts stay exact.
  for(const panel of panels){const slots=new Map();for(const cell of panel.cells)for(const [dx,dy]of [[1,0],[-1,0],[0,1],[0,-1]]){const x=cell.x+dx,y=cell.y+dy;if(x<0||y<0||x>=panel.width||y>=panel.height)continue;const p=cell.p.map((v,i)=>v+panel.u[i]*dx+panel.v[i]*dy),other=cellMap.get(key(p));if(!other||other.panelId===panel.id||dot(DIRECTIONS[other.face].n,panel.normal)!==0)continue;if(dot(other.p,panel.normal)!==panel.plane)continue;slots.set(x+','+y,{x,y,hole:true})}panel.slots=[...slots.values()];}
  const seams=[...contacts.values()].map((s,i)=>({...s,count:s.count/2,id:'S'+String(i+1).padStart(2,'0')}));panels.forEach(p=>p.seams=seams.filter(s=>s.panels.includes(p.id)).map(s=>s.id));
  const palette=new Map();surface.forEach(c=>{if(!palette.has(c.code))palette.set(c.code,{code:c.code,hex:c.hex,transparent:Boolean(c.transparent),count:0});palette.get(c.code).count++});
  const warnings=[];if(parallelContacts)warnings.push('部分薄部件为平行贴合面，无法垂直拼插，需要另行固定。');if(panels.some(p=>p.cells.length<4))warnings.push('含不足 4 豆的小部件，熨烫与固定需要人工调整。');if(panels.some(p=>(p.width===1||p.height===1)&&p.cells.length>1))warnings.push('含仅一豆宽的长条部件，熨烫后强度有限，需要额外支撑或人工加固。');if(panels.some(p=>p.width>52||p.height>52))warnings.push('部分面超过 52×52，请使用更大的豆板；本图不会自动缩小或裁切。');if(panels.length>6&&!flat)warnings.push('复杂模型存在多处接缝；先在爆炸图核对部件顺序，再制作连接处小样。');return {panels,seams,surface,palette:[...palette.values()].sort((a,b)=>b.count-a.count),warnings};
}
