import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function within(base,relative) {
  if(typeof relative!=='string'||!relative||relative.split(/[\\/]/).some(part=>!part||part==='.'||part==='..')||path.isAbsolute(relative))throw new Error('Invalid dependency path: '+relative);
  const result=path.resolve(base,relative);
  if(!result.startsWith(base+path.sep))throw new Error('Dependency path leaves project: '+relative);
  return result;
}
async function status(filename) {
  try{return await fs.lstat(filename);}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
async function directory(base,relative) {
  let current=base;
  for(const part of relative.split('/')) {
    current=within(current,part);
    const entry=await status(current);
    // Remove only the link itself. Never follow a previous pnpm junction into
    // its target, which may belong to another checkout or package manager.
    if(entry?.isSymbolicLink())await fs.unlink(current);
    else if(entry&&!entry.isDirectory())throw new Error('Expected dependency directory: '+current);
    if(!entry||entry.isSymbolicLink())await fs.mkdir(current,{recursive:false});
  }
  return current;
}
async function assertRegularTree(base) {
  for(const entry of await fs.readdir(base,{withFileTypes:true})) {
    const filename=within(base,entry.name);
    if(entry.isSymbolicLink())throw new Error('Vendored dependencies must not contain links: '+filename);
    if(entry.isDirectory())await assertRegularTree(filename);
    else if(!entry.isFile())throw new Error('Unexpected dependency file type: '+filename);
  }
}

/** Prepare the exact bundled packages using only Node's standard library. */
export async function prepareDependencies({quiet=false}={}) {
  const manifest=JSON.parse(await fs.readFile(path.join(root,'vendor/dependencies.json'),'utf8'));
  const sourceRoot=path.join(root,'vendor/node');
  if((await fs.lstat(sourceRoot)).isSymbolicLink())throw new Error('vendor/node must be a real directory');
  await assertRegularTree(sourceRoot);
  const destinationRoot=await directory(root,'node_modules');
  let copied=0,verified=0;
  for(const pkg of manifest.packages) {
    if(!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(pkg.name))throw new Error('Invalid vendored package name');
    const sourcePackage=within(sourceRoot,pkg.name);
    const destinationPackage=await directory(destinationRoot,pkg.name);
    for(const file of pkg.files) {
      const source=within(sourcePackage,file.path);
      const bytes=await fs.readFile(source);
      if(bytes.length!==file.bytes||sha256(bytes)!==file.sha256)throw new Error('Vendored dependency checksum mismatch: '+pkg.name+'/'+file.path);
      const destination=within(destinationPackage,file.path);
      const parent=path.posix.dirname(file.path);
      if(parent!=='.')await directory(destinationPackage,parent);
      let entry=await status(destination);
      if(entry?.isSymbolicLink()){await fs.unlink(destination);entry=null;}
      if(entry&&!entry.isFile())throw new Error('Expected dependency file: '+destination);
      if(!entry||entry.size!==bytes.length||sha256(await fs.readFile(destination))!==file.sha256) {
        await fs.writeFile(destination,bytes);
        copied++;
      }
      if(process.platform!=='win32'&&Number.isInteger(file.mode))await fs.chmod(destination,file.mode);
      verified++;
    }
  }
  if(!quiet)console.log(`Offline dependencies ready: ${manifest.packages.length} packages, ${verified} verified files, ${copied} copied or repaired. No network or package install scripts used.`);
  return {packages:manifest.packages.length,files:verified,copied};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await prepareDependencies();
