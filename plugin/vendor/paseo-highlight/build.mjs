// Reproduce the vendored native implementation from the pinned Paseo Nix closure.
// Usage: node build.mjs <Paseo package /lib/paseo> <pinned upstream source>
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const npmCache = process.argv[4];
const [pkg, source] = process.argv.slice(2).map(p => resolve(p));
if (!pkg || !source) throw Error('Provide immutable Paseo package and upstream source');
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../client/vendor/paseo-highlight');
await mkdir(out,{recursive:true});
const require = createRequire(join(pkg, 'packages/server/package.json'));
const esbuild = require('esbuild');
const result = await esbuild.build({
 absWorkingDir: out, stdin: { contents: 'export {highlightCode,resolveSyntaxColors} from "@getpaseo/highlight"; export {highlightToKeyedLines,extensionFromPath,tokenizeToLines} from "@native/highlight-cache"; export {highlightDiffLines} from "@native/diff-highlight";', resolveDir: out, loader: 'ts' },
 alias: { '@getpaseo/highlight': join(pkg,'packages/highlight/dist/index.js'), '@native/highlight-cache': join(source,'packages/app/src/utils/highlight-cache.ts'), '@native/diff-highlight': join(source,'packages/app/src/utils/diff-highlight.ts'), '@/utils/highlight-cache': join(source,'packages/app/src/utils/highlight-cache.ts') },
 nodePaths: [join(pkg,'node_modules'),join(pkg,'packages/server/node_modules')],
 bundle: true, format: 'esm', platform: 'browser', target: 'es2022', treeShaking: true, minifyWhitespace: true,
 legalComments: 'eof', write: false, metafile: true,
 banner: { js: '// Generated from exact Paseo v0.12.0 native implementation. Apache-2.0 + dependency licenses: licenses/ and provenance.json. DO NOT HAND EDIT.' },
});
const code=result.outputFiles[0].text;
await writeFile(join(out,'index.js'),code);
const hashes=[], packages=new Map();
for(const input of Object.keys(result.metafile.inputs)) {
 if(input.startsWith('<'))continue;
 const file=resolve(out,input), data=await readFile(file);
 hashes.push({file:file.startsWith(source)?file.slice(source.length+1):file.startsWith(pkg)?file.slice(pkg.length+1):file,sha256:createHash('sha256').update(data).digest('hex')});
 if(!file.includes('/node_modules/'))continue;
 let directory=dirname(file);
 while(directory!=='/') {try {const metadata=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));if(metadata.name){packages.set(metadata.name,{directory,metadata});break;}}catch{} directory=dirname(directory);}
}
await mkdir(join(out,'licenses'),{recursive:true});
const dependencies=[];
for(const {directory,metadata} of [...packages.values()].sort((a,b)=>a.metadata.name.localeCompare(b.metadata.name))) {
 let license;
 for(const name of ['LICENSE','LICENSE.md','LICENSE.txt','LICENSE-MIT','license','license.md'])try{await access(join(directory,name));license=await readFile(join(directory,name),'utf8');break;}catch{}
 if(!license && npmCache) {
  const lock=JSON.parse(await readFile(join(npmCache,'package-lock.json'),'utf8'));
  const entry=Object.entries(lock.packages).find(([key,value])=>(key==='node_modules/'+metadata.name||key.endsWith('/node_modules/'+metadata.name))&&value.version===metadata.version)?.[1];
  if(entry?.integrity) {
   const [algorithm,encoded]=entry.integrity.split('-'),hex=Buffer.from(encoded,'base64').toString('hex');
   const archive=join(npmCache,'_cacache/content-v2',algorithm,hex.slice(0,2),hex.slice(2,4),hex.slice(4));
   const files=execFileSync('tar',['-tf',archive],{encoding:'utf8'}).trim().split('\n');
   const file=files.find(name=>/^package\/(?:license|licence)(?:[.-].*)?$/i.test(name));
   if(file)license=execFileSync('tar',['-xOf',archive,file],{encoding:'utf8'});
  }
 }
 if(!license)throw Error(`Missing license text: ${metadata.name}`);
 const filename=metadata.name.replaceAll('/','_').replace('@','')+'.txt';await writeFile(join(out,'licenses',filename),license);
 dependencies.push({name:metadata.name,version:metadata.version,license:metadata.license,licenseFile:'licenses/'+filename});
}
await writeFile(join(out,'licenses/PASEO-APACHE-2.0.txt'),await readFile(join(source,'LICENSE')));
await writeFile(join(out,'licenses/ASTRO-MIT.txt'),await readFile(join(source,'packages/highlight/src/astro/LICENSE')));
await writeFile(join(out,'provenance.json'),JSON.stringify({upstream:'https://github.com/getpaseo/paseo',revision:'cafe4b01c8522ff39560241c5deb01427dc8dc5b',version:'0.12.0',implementation:'Unmodified upstream highlighter, parsers, 200-entry/100000-character cache and diff token attachment; only import paths resolved by esbuild',esbuild:esbuild.version,bundleSha256:createHash('sha256').update(code).digest('hex'),dependencies,inputs:hashes},null,2)+'\n');
console.log(JSON.stringify({bytes:Buffer.byteLength(code),dependencies:dependencies.length,inputs:hashes.length}));
