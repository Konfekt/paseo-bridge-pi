import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const walk = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
const text = node => !node ? '' : typeof node === 'string' ? node : typeof node === 'number' ? String(node) : typeof node !== 'object' ? '' : [node.props?.children].flat(Infinity).map(text).join(' ');

test('compiled Tasks replaces three pills, lazily reports category attention and preserves scoped sections', { skip: !compilerPath }, async () => {
  const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
  const { clientBundle } = await compilePlugin({ client: resolve(root, 'index.client.tsx') });
  const observers = [], pills = [], calls = [], queries = [], effects = [], states = [], opened = [];
  let cursor = 0;
  const task = { taskId:'t1',childId:'c1',workerEpoch:'worker1',groupId:'g1',attempt:1,title:'Helper',model:'test/model',status:'waiting-permission',createdAt:'now',updatedAt:'now',pendingInteractions:1,canPrompt:true,canStop:true };
  const status = { available:true,sessionId:'session',runtimeEpoch:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',tasks:[task] };
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
  const load = name => {
    if (name === '@getpaseo/plugin') return { defineRpc: c => c };
    if (name === '@getpaseo/plugin/client') return { useRpc: contract => async input => { contract.input.parse(input); calls.push({name:contract.name,input}); return {}; } };
    if (name === '@getpaseo/plugin/client/ui') return {};
    if (name === '@getpaseo/plugin/client/react-native') return { ScrollView:'ScrollView',TextInput:'TextInput',Icon:'Icon' };
    if (name === 'react-native') return { Text:'Text',View:'View',Pressable:'Pressable' };
    if (name === 'react/jsx-runtime') return { jsx,jsxs:jsx,Fragment:'Fragment' };
    if (name === 'react') return {
      useEffect: fn => { const cleanup=fn(); if(cleanup) effects.push(cleanup); }, useMemo:fn=>fn(), useRef:value=>({current:value}),
      useState: initial => { const i=cursor++; if(!(i in states)) states[i]=typeof initial==='function'?initial():initial; return [states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value;}]; },
    };
    if (name === '@tanstack/react-query') return { useQuery: options => {
      queries.push(options); const key=options.queryKey[0];
      const data=key==='harness-status'||key==='foreground-tasks'?status:key==='harness-list'?{state:'available',items:options.queryKey[1]==='jobs'?[{jobId:'j1',name:'Build',status:'running',createdAt:new Date().toISOString()}]:[{taskId:'t1',title:'Helper',status:'running',attempt:1}]}:undefined;
      return {data,isPending:false,isError:false,isFetching:false,isStale:false,refetch:async()=>{}};
    } };
    return require(name);
  };
  const contribute=(0,eval)(clientBundle)(load).default;
  const cleanup=contribute({
    paseo:{config:{get:async()=>({config:{plugins:{'paseo-accounts':{enabled:true}}}})},agents:{list:async()=>({subscription:{subscribe:observer=>observers.push(observer)}})}},
    addScreen:()=>()=>{},openScreen(){},addWorkspacePanel:()=>()=>{},addHeaderButton:()=>({update(){},remove(){}}), openPanel:(id,target)=>opened.push({id,target}),
    addComposerPill: pill=>{const registration={...pill,updates:[],removed:false,update(value){assert.equal(this.removed,false);this.updates.push(value);},remove(){this.removed=true;}};pills.push(registration);return registration;},
    rpc:async(contract,input)=>{calls.push({name:contract.name,input});return {available:false};},
  });
  const props={context:'agent',agentId:'a',workspaceId:'w',host:{id:'host',label:'Host'},theme:{colors:{foreground:'#fff',foregroundMuted:'#aaa',statusDanger:'#f00',border:'#555',surface1:'#222'}},close(){}};
  try {
    await new Promise(resolve=>setImmediate(resolve));
    const agent={id:'a',workspaceId:'w',provider:'pi',availableModes:[{id:'pi-prompts-on'},{id:'pi-prompts-off'}]};
    observers.forEach(observer=>observer.snapshot({entries:[{agent}]}));
    const control=pills.find(pill=>pill.id==='tasks'); assert.ok(control);
    assert.ok(!pills.some(pill=>['harness-jobs','harness-subagents','foreground-tasks'].includes(pill.id)));
    assert.equal(calls.filter(call=>/harness|foreground/.test(call.name)).length,0,'hidden controls perform no task RPC');
    const icon=control.button.icon({...props,size:14,color:'#aaa'});
    assert.equal(icon.props.color,'#f00');
    assert.equal(control.updates.at(-1).label,'Tasks · attention');
    assert.match(control.updates.at(-1).title,/foreground: 0 running, 1 needing attention/);
    const render=()=>{cursor=0;queries.length=0;return control.button.behavior.Content(props);};
    let tree=render();
    assert.match(text(tree),/Helper · waiting-permission/);
    assert.equal(walk(tree).some(n=>n.type==='ScrollView'),false,'host owns popover scrolling');
    for (const label of ['Jobs','Agents','Foreground']) {
      const tab=walk(tree).find(n=>n.props?.accessibilityRole==='tab'&&n.props.accessibilityLabel===label);assert.ok(tab,label);tab.props.onPress();tree=render();
      assert.ok(walk(tree).some(n=>n.props?.accessibilityRole==='tab'&&n.props.accessibilityLabel===label&&n.props.accessibilityState.selected));
      if (label==='Agents') {
        walk(tree).find(n=>n.props?.accessibilityLabel==='Open Agents panel').props.onPress();
        assert.deepEqual(opened.at(-1),{id:'harness-subagents',target:{agentId:'a',workspaceId:'w'}});
      }
    }
    const bound=queries.find(q=>q.queryKey[0]==='harness-list'&&q.queryKey[1]==='jobs');
    await bound.queryFn(); assert.deepEqual(calls.at(-1).input,{agentId:'a',workspaceId:'w',expectedSessionId:'session',expectedRuntimeEpoch:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',limit:50});
    assert.ok(bound.queryKey.includes('host'));
    const prior=control.updates.length;
    observers.forEach(observer=>observer.update({type:'agent_update',payload:{kind:'remove',agentId:'a'}}));
    control.button.icon({...props,size:14,color:'#aaa'});
    assert.equal(control.removed,true); assert.equal(control.updates.length,prior,'removed controls ignore late summaries');
  } finally {effects.forEach(fn=>fn());cleanup();}
});
