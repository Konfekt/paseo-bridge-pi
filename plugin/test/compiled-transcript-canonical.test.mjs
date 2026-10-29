import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, cp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nativeToolParityCases, exactBackgroundStart, structuredToolNames } from './fixtures/native-tool-parity.mjs';

const compiler = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compiler, 'PASEO_PLUGIN_COMPILER is required');

test('emitted Work renderer uses native mapper/display for every supported Pi family and Paseo catalog entry', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'transcript-canonical-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['client','shared']) await cp(fileURLToPath(new URL(`../${dir}`, import.meta.url)), resolve(root, dir), { recursive: true });
  await writeFile(resolve(root, 'index.client.tsx'), `export { NativeToolBadge, NativeRunningTurnFooter } from "./client/native-transcript";
export {nativeToolModel,nativeToolSections,nativeToolPresentation} from "./client/native-tool-presentation";
export {literalToolResult} from "./client/native-tool-details";
import {SPINNER_DOT_COUNT,getMarkdownTextMetrics} from "./client/native-transcript-model";
export function canonical(){return {count:SPINNER_DOT_COUNT,metrics:getMarkdownTextMetrics(12)}}`);
  const { compilePlugin } = await import(pathToFileURL(resolve(compiler)));
  const { clientBundle } = await compilePlugin({ client: resolve(root, 'index.client.tsx'), server: null });
  assert.ok(clientBundle);
  const require = createRequire(resolve(compiler));
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const hostImports=[];
  const exports = (0, eval)(clientBundle)(name => {
    hostImports.push(name);
    if (name === 'react') return { useEffect() {}, useState: value => [typeof value === 'function' ? value() : value, () => {}] };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react-native') return { View: 'View', Text: 'Text', Pressable: 'Pressable' };
    if (name === '@getpaseo/plugin/client/react-native') return { Icon: 'Icon', ScrollView: 'ScrollView' };
    if (name === 'zod') return require(name); // existing public host dependency, not a new SDK
    throw new Error(`Unexpected runtime dependency: ${name}`);
  });
  assert.ok(!hostImports.some(name => name.startsWith('@getpaseo/server') || name.startsWith('@getpaseo/protocol')));
  const mapper = await import(pathToFileURL(require.resolve('@getpaseo/server/pi-tool-presentation')));
  const display = await import(pathToFileURL(require.resolve('@getpaseo/protocol/tool-call-display')));
  const generic = await import(pathToFileURL(require.resolve('@getpaseo/protocol/generic-tool-presentation')));
  const paseo = await import(pathToFileURL(require.resolve('@getpaseo/protocol/paseo-tool-presentation/index')));
  const cases = nativeToolParityCases(paseo.PASEO_TOOL_NAMES);
  const types=new Set(),families=new Set();
  for (const fixture of cases) {
    const {name,input,output}=fixture,status=fixture.status??'completed';
    const expectedDetail=mapper.mapPiToolCallDetail(mapper.parseToolArgs(name,input),mapper.parseToolResult(output));
    const expectedDisplay=display.buildToolCallDisplayModel({name,detail:expectedDetail,status,error:status==='failed'?mapper.nativeToolErrorText(output,name):null});
    const actual=exports.nativeToolModel(name,input,output,status);
    assert.deepEqual(actual.detail,expectedDetail,`${fixture.id}: actual native mapping`);
    assert.deepEqual(actual.display,expectedDisplay,`${fixture.id}: actual native badge/display policy`);
    types.add(actual.detail.type);families.add(fixture.family);
  }
  for(const type of ['shell','read','write','edit','search','plain_text','sub_agent','unknown'])assert.ok(types.has(type),`coverage: ${type}`);
  for(const name of structuredToolNames)assert.ok(cases.some(fixture=>fixture.name===name)&&generic.hasGenericToolPresentation(name),`custom tool coverage: ${name}`);
  assert.equal(cases.filter(fixture=>fixture.id.startsWith('paseo-')&&fixture.id!=='paseo-fields').length,paseo.PASEO_TOOL_NAMES.length,'every canonical Paseo catalog entry tested');
  assert.ok(families.size>=20);

  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== 'object' ? [] : typeof value.type === 'function' ? nodes(value.type(value.props)) : [value, ...nodes(value.props.children)];
  const spinner = nodes(exports.NativeRunningTurnFooter({ color: '#888888' }));
  assert.equal(spinner.filter(node => node.props.style?.position === 'absolute').length,exports.canonical().count);
  const badge=nodes(exports.NativeToolBadge({name:'read',status:'completed',argumentsValue:{path:'notes.txt',offset:4},result:'hello',colors:{foreground:'#111111',foregroundMuted:'#888888',surface0:'#ffffff'},expanded:true,onToggle(){}}));
  const line=badge.find(node=>node.props.testID==='work-code-line');
  const gutter=badge.find(node=>node.props.testID==='work-code-line-number');assert.ok(line);assert.ok(gutter);
  for(const node of [line,gutter]){assert.equal(node.props.style.fontSize,exports.canonical().metrics.fontSize);assert.equal(node.props.style.lineHeight,exports.canonical().metrics.lineHeight);}
  assert.equal(gutter.props.children,'4');

  const prompt=cases.find(fixture=>fixture.id==='prompt');
  const promptModel=exports.nativeToolModel(prompt.name,prompt.input,JSON.stringify(prompt.output));
  assert.equal(promptModel.detail.text,'Review the actual output; do not send anything.');
  assert.equal(promptModel.display.summary,'Child instruction','actual 1b36 native mapper label, not a second generic label');
  const named=cases.find(fixture=>fixture.id==='display-name');
  const namedText=exports.nativeToolModel(named.name,named.input,JSON.stringify(named.output)).detail.text;
  assert.match(namedText,/Readable Worker/,'ordinary serialized group.children retains displayName');
  assert.doesNotMatch(namedText,/legacy-worker/);
  const rendered=nodes(exports.NativeToolBadge({name:prompt.name,status:'completed',argumentsValue:prompt.input,result:JSON.stringify(prompt.output),colors:{},expanded:true,onToggle(){}}));
  assert.ok(rendered.some(node=>node.props.testID==='work-native-tool-section'));
  assert.ok(!rendered.some(node=>node.props.testID==='work-code-line'),'canonical prose is not forced into code');

  const raw=exports.nativeToolModel(exactBackgroundStart.name,exactBackgroundStart.input,exactBackgroundStart.raw);
  assert.equal(raw.detail.text,exactBackgroundStart.raw,'legacy raw result stays verbatim; never infer job status from a header');
  const typed=exports.nativeToolModel(exactBackgroundStart.name,exactBackgroundStart.input,exactBackgroundStart.typed);
  assert.match(typed.detail.text,/Ready repaired Accounts repeat proof\nRunning/);
  assert.doesNotMatch(typed.detail.text,/Started in a new tmux pane|Arguments|"action"/,'typed lifecycle uses canonical native projection, not a JSON dump');

  const literal='{"content":[{"type":"text","text":"must stay literal"}]}';
  const literalModel=exports.nativeToolModel('custom_tool',{},exports.literalToolResult(literal,'text'));
  assert.ok(literalModel.detail.text.includes(literal));
  const binary='SECRET_BASE64_MEDIA';
  const media={content:[{type:'image',mimeType:'image/png',data:binary},{type:'text',text:'Human note'}]};
  for(const output of [media,JSON.stringify(media),JSON.stringify(JSON.stringify(media))]){
    const value=JSON.stringify(exports.nativeToolModel('custom_tool',undefined,output));assert.ok(!value.includes(binary));assert.ok(value.includes('image'));assert.ok(value.includes('Human note'));
  }
  const giant=exports.nativeToolSections('custom_tool',{message:'😀'.repeat(50000)},'y'.repeat(50000));
  const strings=giant.flatMap(section=>section.kind==='fields'?[section.title,...section.fields.flatMap(field=>[field.label,field.value])]:[section.title??section.label,section.text]);
  assert.ok(Buffer.byteLength(strings.join(''))<=24*1024);
  const cycle={};cycle.self=cycle;assert.ok(JSON.stringify(exports.nativeToolSections('custom_tool',cycle,cycle)).includes('circular'));
  const legacyCarrier={type:'tool_result',content:JSON.stringify({content:[{type:'text',text:'Legacy nested result'}]})};
  assert.equal(exports.nativeToolModel('read',{path:'legacy.txt'},legacyCarrier).detail.content,'Legacy nested result');
  for(const name of ['constructor','__proto__','toString']){
    const reserved=exports.nativeToolModel(name,{},exports.literalToolResult('Literal reserved-name output','text'));
    assert.equal(reserved.detail.type,'plain_text');assert.ok(reserved.detail.text.includes('Literal reserved-name output'));
  }

  if(process.env.HERMESC){const source=resolve(root,'emitted-client.js'),bytecode=resolve(root,'emitted-client.hbc');await writeFile(source,clientBundle);execFileSync(process.env.HERMESC,['-emit-binary','-out',bytecode,source],{stdio:'pipe'});assert.ok((await stat(bytecode)).size>0);}
  console.log(`Canonical parity: ${cases.length} cases, ${families.size} families, ${paseo.PASEO_TOOL_NAMES.length} Paseo entries; host imports ${[...new Set(hostImports)].join(', ')}`);
});
