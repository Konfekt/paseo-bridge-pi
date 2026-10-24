import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {mkdtemp,cp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';

const compilerPath=process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compilerPath,'PASEO_PLUGIN_COMPILER is required');
const require=createRequire(resolve(compilerPath));
const {compilePlugin}=await import(pathToFileURL(resolve(compilerPath)));
const fixtureRoot=await mkdtemp(join(tmpdir(),'btw-default-ui-'));
let clientBundle;
try {
  for(const part of ['client','shared'])await cp(fileURLToPath(new URL(`../${part}`,import.meta.url)),join(fixtureRoot,part),{recursive:true});
  await writeFile(join(fixtureRoot,'index.client.tsx'),'export { BtwPanel } from "./client/btw";');
  ({clientBundle}=await compilePlugin({client:join(fixtureRoot,'index.client.tsx')}));
}finally{await rm(fixtureRoot,{recursive:true,force:true});}
const nodes=x=>Array.isArray(x)?x.flatMap(nodes):!x||typeof x!=='object'?[]:[x,...nodes(x.props?.children)];
const text=x=>Array.isArray(x)?x.map(text).join(''):typeof x==='string'?x:x&&typeof x==='object'?text(x.props?.children):'';
function fixture(defaultModel,models){
  let index=0,queryPending;
  const hooks=[],requests=[];
  const snapshot={protocol:1,sessionId:'session',serviceEpoch:'service',defaultModel,models,threads:[]};
  const data=()=>({available:true,sessionId:'session',runtimeEpoch:'runtime',snapshot});
  const jsx=(type,props)=>typeof type==='function'?type(props??{}):({type,props:props??{}});
  const load=name=>{
    if(name==='react')return {
      useState(initial){const i=index++;if(!(i in hooks))hooks[i]=typeof initial==='function'?initial():initial;return [hooks[i],next=>{hooks[i]=typeof next==='function'?next(hooks[i]):next;}];},
      useRef(initial){const i=index++;return hooks[i]??=( {current:initial} );},useEffect(){},useSyncExternalStore:(_,get)=>get(),
    };
    if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};
    if(name==='react-native')return {View:'View',Text:'Text',Pressable:'Pressable'};
    if(name==='@getpaseo/plugin')return {defineRpc:x=>x};
    if(name==='@getpaseo/plugin/client/react-native')return {Icon:'Icon',Modal:'Modal',ScrollView:'ScrollView',TextInput:'TextInput',copyText:async()=>{}};
    if(name==='@getpaseo/plugin/client/ui')return {SettingsAction:'SettingsAction'};
    if(name==='@getpaseo/plugin/client')return {useRpc:contract=>contract.name==='btw_status'?async()=>data():async input=>{
      requests.push(input.request);
      snapshot.threads=[{id:input.request.threadId,model:input.request.model,context:'recent',state:'idle',question:'',partial:'',error:null,turns:[],turnCount:0}];
      return snapshot;
    }};
    if(name==='@tanstack/react-query')return {useQuery:options=>{queryPending=options.queryFn();return {data:data(),isPending:false,isError:false,isFetching:false,refetch:()=>options.queryFn()};}};
    return require(name);
  };
  const {BtwPanel}=(0,eval)(clientBundle)(load);
  const props={host:{id:'host'},workspaceId:'workspace',agentId:'agent',layout:{platform:'web',compact:false},theme:{colors:{foreground:'#fff',foregroundMuted:'#aaa',surface0:'#111',surface1:'#222',surface2:'#333',border:'#444',statusWarning:'#fa0',statusDanger:'#f00',accent:'#08f'}}};
  const draw=()=>{index=0;return BtwPanel(props);};
  return {requests,async render(){draw();await queryPending;return nodes(draw());}};
}
for(const provider of ['openai','openai-codex'])test(`compiled BTW sends the advertised ${provider} default when creating a fresh chat`,async()=>{
  const model=`${provider}/gpt-6-luna`,f=fixture(model,[model]);
  let all=await f.render();
  all.find(n=>n.type==='TextInput').props.onChangeText('A side question');
  all=await f.render();
  const send=all.find(n=>n.type==='Pressable'&&n.props.accessibilityLabel==='Send message');
  assert.equal(send.props.disabled,false);
  await send.props.onPress();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].operation,'start');assert.equal(f.requests[0].model,model);
  all=await f.render();
  assert.ok(!all.some(n=>text(n).includes('This chat is no longer available')));
});
test('unavailable BTW defaults explain the failure without creating a phantom chat or silently choosing another model',async()=>{
  const f=fixture('openai-codex/missing',['openai-codex/gpt-6-luna']);
  let all=await f.render();
  assert.ok(all.some(n=>text(n).includes('BTW model openai-codex/missing is unavailable for this session. No fallback was made.')));
  all.find(n=>n.type==='TextInput').props.onChangeText('A side question');all=await f.render();
  const send=all.find(n=>n.type==='Pressable'&&n.props.accessibilityLabel==='Send message');
  assert.equal(send.props.disabled,true);await send.props.onPress();assert.equal(f.requests.length,0);
});
