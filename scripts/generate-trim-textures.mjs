/** Materialize vanilla's dynamically recoloured item trim atlas sprites.
 * node scripts/generate-trim-textures.mjs [--root <project>] [--check]
 * Uses only the copied vanilla atlas/palettes and the locally vendored pngjs.
 * The Java 1.21.1 algorithm and source hashes are recorded in
 * docs/trim-texture-sources.json. No game/JDK/Python/network is needed.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const args=process.argv.slice(2),rootIndex=args.indexOf('--root');
const root=path.resolve(rootIndex<0?path.join(path.dirname(fileURLToPath(import.meta.url)),'..'):args[rootIndex+1]);
const check=args.includes('--check');
const {PNG}=createRequire(import.meta.url)(path.join(root,'vendor/node/pngjs/lib/png.js'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=relative=>fs.readFile(path.join(root,relative));
const atlasPath='public/minecraft/atlases/blocks.json';
const atlasBytes=await read(atlasPath),atlas=JSON.parse(atlasBytes);
const evidence=JSON.parse(await read('docs/trim-texture-sources.json'));
if(evidence.atlas.sha256!==hash(atlasBytes))throw new Error('Atlas differs from recorded source evidence');
const inputs=new Map(),outputs=[];
function texturePath(id){
  const clean=id.replace(/^minecraft:/,'');
  if(!/^[a-z0-9_/.-]+$/.test(clean)||clean.split('/').includes('..'))throw new Error('Invalid vanilla texture id');
  return `public/minecraft/textures/${clean}.png`;
}
async function texture(id){
  const relative=texturePath(id),bytes=await read(relative);
  inputs.set(relative,{path:relative,sha256:hash(bytes),bytes:bytes.length});
  return PNG.sync.read(bytes);
}
const rgbKey=(data,index)=>(data[index]<<16)|(data[index+1]<<8)|data[index+2];
for(const source of atlas.sources){
  if(source.type.replace(/^minecraft:/,'')!=='paletted_permutations')continue;
  const itemTextures=source.textures.filter(id=>id.replace(/^minecraft:/,'').startsWith('trims/items/'));
  if(!itemTextures.length)continue;
  const key=await texture(source.palette_key);
  for(const [suffix,paletteId] of Object.entries(source.permutations)){
    if(!/^[a-z0-9_]+$/.test(suffix))throw new Error('Invalid palette suffix');
    const palette=await texture(paletteId);
    if(key.data.length!==palette.data.length)throw new Error(`Mismatched palette lengths: ${paletteId}`);
    const mapping=new Map();
    for(let i=0;i<key.data.length;i+=4)if(key.data[i+3]!==0)mapping.set(rgbKey(key.data,i),palette.data.subarray(i,i+4));
    for(const id of itemTextures){
      const base=await texture(id),result={width:base.width,height:base.height,data:Buffer.from(base.data)};
      for(let i=0;i<base.data.length;i+=4){
        const alpha=base.data[i+3];if(!alpha)continue;
        const target=mapping.get(rgbKey(base.data,i));if(!target)continue;
        result.data[i]=target[0];result.data[i+1]=target[1];result.data[i+2]=target[2];
        result.data[i+3]=Math.floor(alpha*target[3]/255);
      }
      const relative=texturePath(`${id}_${suffix}`),bytes=PNG.sync.write(result,{colorType:6});
      if(check){
        const actual=await read(relative);
        if(!actual.equals(bytes))throw new Error(`Generated trim differs: ${relative}`);
      }else await fs.writeFile(path.join(root,relative),bytes);
      outputs.push({path:relative,texture:id,palette:paletteId,width:result.width,height:result.height,bytes:bytes.length,sha256:hash(bytes),rgbaSha256:hash(result.data)});
    }
  }
}
if(outputs.length!==56)throw new Error(`Expected 56 vanilla item trim permutations, received ${outputs.length}`);
const manifest={schemaVersion:1,minecraftVersion:'Java 1.21.1',generator:'scripts/generate-trim-textures.mjs',command:'node scripts/generate-trim-textures.mjs',verifyCommand:'node scripts/generate-trim-textures.mjs --check',runtimeDependencies:['Node.js','vendor/node/pngjs'],sourceEvidence:'docs/trim-texture-sources.json',atlas:{path:atlasPath,sha256:hash(atlasBytes)},algorithm:evidence.algorithm,inputs:[...inputs.values()].sort((a,b)=>a.path.localeCompare(b.path)),count:outputs.length,outputs:outputs.sort((a,b)=>a.path.localeCompare(b.path))};
const manifestBytes=JSON.stringify(manifest,null,2)+'\n';
if(check){if((await read('docs/generated-trim-textures.json')).toString()!==manifestBytes)throw new Error('Trim generation manifest is stale')}
else await fs.writeFile(path.join(root,'docs/generated-trim-textures.json'),manifestBytes);
console.log(`${check?'Verified':'Generated'} ${outputs.length} item trim textures from the local vanilla atlas and palettes.`);
