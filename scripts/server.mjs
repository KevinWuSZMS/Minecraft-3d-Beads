import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const portArg=process.argv.indexOf('--port');
const port=Number(portArg>=0?process.argv[portArg+1]:(process.env.PORT||4173));
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid local port. Use --port 4173.');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg'};
http.createServer((req,res)=>{let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname)}catch{res.writeHead(400).end();return}
if(pathname==='/__mc3dbeads_health'){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({app:'MC3DBeads',root:path.dirname(root),port}));return}
const p=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!p.startsWith(root+path.sep)){res.writeHead(403).end();return}fs.stat(p,(e,s)=>{if(e||!s.isFile()){res.writeHead(404).end('Not found');return}res.writeHead(200,{'Content-Type':mime[path.extname(p)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});fs.createReadStream(p).on('error',()=>res.destroy()).pipe(res)})}).on('error',error=>{console.error(`MC3DBeads could not listen on 127.0.0.1:${port}: ${error.message}`);process.exitCode=1}).listen(port,'127.0.0.1',()=>console.log(`MC3DBeads Local: http://127.0.0.1:${port}`));
