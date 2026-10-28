import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { cp, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compilerPath=process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compilerPath,'PASEO_PLUGIN_COMPILER is required');
const require=createRequire(resolve(compilerPath));
const {compilePlugin}=await import(pathToFileURL(resolve(compilerPath)));
const fixture=await mkdtemp(resolve(tmpdir(),'delegated-goals-ui-'));
after(()=>rm(fixture,{recursive:true,force:true}));
for(const directory of ['client','shared']) await cp(fileURLToPath(new URL(`../${directory}`,import.meta.url)),resolve(fixture,directory),{recursive:true});
await writeFile(resolve(fixture,'index.client.tsx'),'export { DelegatedGoals } from "./client/delegated-goals"; export { LegacyGoals } from "./client/legacy-goals";');
const {clientBundle}=await compilePlugin({client:resolve(fixture,'index.client.tsx')});
const colors={foreground:'#eee',foregroundMuted:'#999',surface1:'#222',surface2:'#333',border:'#444',accent:'#eee',accentForeground:'#111',statusWarning:'#fa0',statusDanger:'#f66'};
function harness() {
 const states=new Map();let context;
 const jsx=(type,props)=>({type,props:props??{}});
 const load=name=>{
  if(name==='react')return {
   useState(initial){const local=context;const i=local.cursor++;if(!(i in local.slots))local.slots[i]=typeof initial==='function'?initial():initial;return [local.slots[i],next=>{local.slots[i]=typeof next==='function'?next(local.slots[i]):next;}];},
   useSyncExternalStore(_subscribe,get){return get();},
  };
  if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};
  if(name==='react-native')return {View:'View',Text:'Text',Pressable:'Pressable'};
  if(name==='@getpaseo/plugin/client/react-native')return {TextInput:'TextInput',ScrollView:'ScrollView'};
  if(name==='@getpaseo/plugin/client/ui')return {Icon:'Icon',SettingsSection:'SettingsSection',SettingsCard:'SettingsCard',SettingsAction:'SettingsAction',Modal:Object.assign(props=>jsx('Modal',props),{Content:'ModalContent'})};
  return require(name);
 };
 const {DelegatedGoals,LegacyGoals}=(0,eval)(clientBundle)(load);
 function walk(node,path='root') {
  if(Array.isArray(node))return node.flatMap((item,index)=>walk(item,`${path}/${index}`));
  if(!node||typeof node!=='object')return [];
  if(typeof node.type==='function'){
   const key=`${path}:${node.type.name}:${node.props.key??''}`;const slots=states.get(key)??[];states.set(key,slots);context={slots,cursor:0};return walk(node.type(node.props),key);
  }
  return [node,...walk(node.props.children,`${path}/children`)];
 }
 return {draw:props=>walk({type:DelegatedGoals,props}),parent:props=>walk({type:LegacyGoals,props}),remount:()=>states.clear()};
}
const entry=(id,status='paused')=>({id,revision:2,text:`Goal ${id}`,status,tasks:[],child:null,tokenBudget:null,tokensUsed:0,automaticTurns:0,noProgressTurns:0,summary:null,waiting:null});
const button=(nodes,label)=>nodes.find(node=>node.type==='Pressable'&&node.props.accessibilityLabel===label);
const textbox=(nodes,label)=>nodes.find(node=>node.type==='TextInput'&&node.props.accessibilityLabel===label);
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('compiled multi-goal creation is independent of parent idle and uses explicit paused registry action',async()=>{
 const h=harness();const calls=[];const props={registry:{version:1,revision:4,entries:[]},colors,identity:'creation-session',locked:false,busy:false,executionAvailable:false,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);assert.equal(button(nodes,'Create').props.disabled,true);
 textbox(nodes,'New goal').props.onChangeText('Ship independent children');
 nodes=h.draw(props);assert.equal(button(nodes,'Create').props.disabled,false);
 textbox(nodes,'Goal token budget').props.onChangeText('1.5');nodes=h.draw(props);assert.equal(button(nodes,'Create').props.disabled,true);
 textbox(nodes,'Goal token budget').props.onChangeText('');nodes=h.draw(props);
 button(nodes,'Create').props.onPress();await tick();
 assert.deepEqual(calls,[{operation:'start',action:'goals.create',expectedGoalId:null,objective:'Ship independent children'}]);
 props.locked=true;nodes=h.draw(props);assert.equal(button(nodes,'Create').props.disabled,true);
 props.locked=false;props.busy=true;nodes=h.draw(props);assert.equal(button(nodes,'Create').props.disabled,true);
});

test('selection and draft survive compact host remount, with active-child clear guarded',async()=>{
 const h=harness();const calls=[];const first=entry('first','active'),second=entry('second');
 first.child={taskId:'task-one',childId:'child-one',jobId:'job-one',attempt:1};
 const props={registry:{version:1,revision:3,entries:[first,second]},colors,identity:'remount-session',locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);button(nodes,'Goal first').props.onPress();nodes=h.draw(props);
 assert.equal(button(nodes,'Clear').props.disabled,true);
 assert.equal(button(nodes,'Edit').props.disabled,true);
 button(nodes,'Pause').props.onPress();await tick();assert.equal(calls[0].action,'goals.pause');assert.equal(calls[0].expectedEntryRevision,2);
 h.remount();nodes=h.draw(props);assert.ok(button(nodes,'Pause'),'selection survives frame remount');
 button(nodes,'Back to goals').props.onPress();nodes=h.draw(props);button(nodes,'New goal').props.onPress();nodes=h.draw(props);
 textbox(nodes,'New goal').props.onChangeText('Retain this draft');
 h.remount();nodes=h.draw(props);assert.equal(textbox(nodes,'New goal').props.value,'Retain this draft');
});

test('edit submits the seeded revision rather than overwriting a newer registry entry',async()=>{
 const h=harness();const calls=[];const goal=entry('edit');
 const props={registry:{version:1,revision:1,entries:[goal]},colors,identity:'edit-session',locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);button(nodes,'Goal edit').props.onPress();nodes=h.draw(props);button(nodes,'Edit').props.onPress();nodes=h.draw(props);
 textbox(nodes,'Goal objective').props.onChangeText('My draft');
 nodes=h.draw(props);button(nodes,'Save changes').props.onPress();await tick();
 goal.revision=3;h.remount();nodes=h.draw(props);
 assert.equal(button(nodes,'Save changes').props.disabled,true,'changed revision requires review, even after remount');
 button(nodes,'Save changes').props.onPress();await tick();assert.equal(calls.length,1);
 assert.equal(calls[0].expectedEntryRevision,2);assert.equal(calls[0].objective,'My draft');assert.equal(calls[0].tokenBudget,null,'empty edit budget explicitly restores unlimited');
});

test('successful create selects its own new entry even when objectives are equal',async()=>{
 const h=harness();const calls=[];const existing=entry('existing');existing.text='Same outcome';
 const props={registry:{version:1,revision:1,entries:[existing]},colors,identity:'successful-create',locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{
  calls.push(fields);if(fields.action!=='goals.create')return false;
  const created=entry('created');created.text=fields.objective;
  props.registry={...props.registry,revision:2,entries:[existing,created]};return {snapshot:{delegatedGoals:props.registry}};
 }};
 let nodes=h.draw(props);button(nodes,'New goal').props.onPress();nodes=h.draw(props);textbox(nodes,'New goal').props.onChangeText('Same outcome');
 nodes=h.draw(props);button(nodes,'Create').props.onPress();await tick();nodes=h.draw(props);button(nodes,'Start').props.onPress();await tick();
 assert.equal(calls[1].expectedGoalId,'created');assert.equal(calls[1].action,'goals.start');
});

test('ambiguous concurrent creations require selection instead of guessing a goal identity',async()=>{
 const h=harness();const existing=entry('known');const props={registry:{version:1,revision:1,entries:[existing]},colors,identity:'concurrent-create',locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{
  const own=entry('own'),other=entry('other');own.text=other.text=fields.objective;
  props.registry={version:1,revision:3,entries:[existing,own,other]};return {snapshot:{delegatedGoals:props.registry}};
 }};
 let nodes=h.draw(props);nodes.find(node=>node.props.onLayout).props.onLayout({nativeEvent:{layout:{width:1100}}});nodes=h.draw(props);
 button(nodes,'New goal').props.onPress();nodes=h.draw(props);textbox(nodes,'New goal').props.onChangeText('Shared objective');nodes=h.draw(props);
 button(nodes,'Create').props.onPress();await tick();nodes=h.draw(props);
 assert.equal(button(nodes,'Start'),undefined);assert.ok(nodes.some(node=>node.type==='Text'&&node.props.children==='Goal saved. Select an entry to review.'));
});

test('clear opens a native confirmation and invalidates it when the entry changes',()=>{
 const h=harness();const calls=[];const goal=entry('clear');
 const props={registry:{version:1,revision:1,entries:[goal]},colors,identity:'clear-session',locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);button(nodes,'Goal clear').props.onPress();nodes=h.draw(props);button(nodes,'Clear').props.onPress();nodes=h.draw(props);
 assert.equal(calls.length,0);assert.ok(nodes.some(node=>node.type==='Modal'));
 assert.equal(button(nodes,'Clear goal').props.disabled,false);
 goal.revision=3;nodes=h.draw(props);assert.equal(button(nodes,'Clear goal').props.disabled,true);assert.equal(calls.length,0);
});

test('desktop default-selection confirmation never retargets when that goal completes',()=>{
 const h=harness();const first=entry('first-default'),second=entry('second-default');const calls=[];
 const props={registry:{version:1,revision:1,entries:[first,second]},colors,identity:'default-selection-guard',locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);nodes.find(node=>node.props.onLayout).props.onLayout({nativeEvent:{layout:{width:1100}}});nodes=h.draw(props);
 button(nodes,'Clear').props.onPress();first.status='complete';first.revision++;nodes=h.draw(props);
 assert.equal(button(nodes,'Clear goal').props.disabled,true);assert.equal(calls.length,0);
 assert.ok(nodes.some(node=>node.type==='Text'&&node.props.children==='Goal first-default'),'confirmation remains pinned to the intended entry');
});

test('empty completed view does not accidentally display a creation form on desktop',()=>{
 const h=harness();const props={registry:{version:1,revision:0,entries:[]},colors,identity:'empty-history',locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async()=>false};
 let nodes=h.draw(props);nodes.find(node=>node.props.onLayout).props.onLayout({nativeEvent:{layout:{width:1100}}});nodes=h.draw(props);
 button(nodes,'Completed').props.onPress();nodes=h.draw(props);
 assert.equal(button(nodes,'Create'),undefined);assert.ok(nodes.some(node=>node.type==='Text'&&node.props.children==='No completed goals yet'));
});

test('unavailable child capability disables execution without disabling metadata creation',()=>{
 const h=harness();const props={registry:{version:1,revision:1,entries:[entry('offline')]},colors,identity:'offline-session',locked:false,busy:false,executionAvailable:false,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async()=>false};
 let nodes=h.draw(props);button(nodes,'Goal offline').props.onPress();nodes=h.draw(props);
 assert.equal(button(nodes,'Start').props.disabled,true);
 assert.equal(button(nodes,'Edit').props.disabled,false,'unstarted metadata remains editable');
 assert.ok(nodes.some(node=>node.type==='Text'&&node.props.children==='Start and Resume are unavailable in this session'));
 props.registry.entries[0].child={taskId:'owned',childId:'attempt',jobId:'group',attempt:1};
 nodes=h.draw(props);assert.equal(button(nodes,'Edit').props.disabled,false,'linked paused edits are metadata-only');assert.equal(button(nodes,'Add task').props.disabled,false);
 props.registry.entries[0].status='active';nodes=h.draw(props);
 assert.equal(button(nodes,'Pause').props.disabled,false,'revoking launch capability must not remove the safe stop control');
});

test('duplicate trimmed task descriptions are rejected locally before a mutation',async()=>{
 const h=harness();const calls=[];const goal=entry('duplicate');goal.tasks=[{id:'task-1',text:' Verify permissions ',status:'pending'}];
 const props={registry:{version:1,revision:1,entries:[goal]},colors,identity:'duplicate-task',locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);button(nodes,'Goal duplicate').props.onPress();nodes=h.draw(props);button(nodes,'Add task').props.onPress();nodes=h.draw(props);
 textbox(nodes,'Subtask').props.onChangeText('  Verify permissions  ');nodes=h.draw(props);
 assert.equal(button(nodes,'Save task').props.disabled,true);assert.ok(nodes.some(node=>node.type==='Text'&&node.props.children==='That task is already in this goal'));
 button(nodes,'Save task').props.onPress();await tick();assert.equal(calls.length,0);
 textbox(nodes,'Subtask').props.onChangeText('  Verify identities  ');nodes=h.draw(props);assert.equal(button(nodes,'Save task').props.disabled,false);
 button(nodes,'Save task').props.onPress();await tick();assert.equal(calls[0].action,'goals.add_task');assert.equal(calls[0].text,'Verify identities');
});

test('exhausted budgets gate Resume in every stopped state without removing Pause',async()=>{
 for(const status of ['paused','blocked','usage_limited','budget_limited']) {
  const h=harness();const calls=[];const goal=entry('limited',status);goal.child={taskId:'owned',childId:'attempt',jobId:'group',attempt:1};goal.tokenBudget=100;goal.tokensUsed=100;
  const props={registry:{version:1,revision:1,entries:[goal]},colors,identity:`budget-${status}`,locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{calls.push(fields);return false;}};
  let nodes=h.draw(props);button(nodes,'Goal limited').props.onPress();nodes=h.draw(props);
  assert.equal(button(nodes,'Resume').props.disabled,true,status);assert.ok(nodes.some(node=>node.type==='Text'&&node.props.children==='Raise or remove the token budget before resuming'));
  button(nodes,'Resume').props.onPress();await tick();assert.equal(calls.length,0);
  goal.tokenBudget=null;goal.revision++;nodes=h.draw(props);assert.equal(button(nodes,'Resume').props.disabled,false,status);
  button(nodes,'Resume').props.onPress();await tick();assert.equal(calls[0].action,'goals.resume');
  goal.status='active';goal.tokenBudget=100;goal.tokensUsed=101;nodes=h.draw(props);assert.equal(button(nodes,'Pause').props.disabled,false);
 }
});

for (const width of [390, 1100]) test(`assignment lists are independent of status at ${width}px`,()=>{
 const h=harness();const paused=entry('linked-paused');paused.child={taskId:'real-child',childId:'child',jobId:'job',attempt:1};
 const active=entry('unlinked-active','active');const saved=entry('saved');
 const done=entry('done','complete');done.child=paused.child;
 const cleared=entry('cleared','cleared');
 const props={registry:{version:1,revision:1,entries:[paused,active,saved,done,cleared]},colors,identity:`assignment-${width}`,locked:false,busy:false,executionAvailable:true,model:null,limits:{},post:async()=>{throw Error('fixture must not mutate');}};
 let nodes=h.draw(props);nodes.find(n=>n.props.onLayout).props.onLayout({nativeEvent:{layout:{width}}});nodes=h.draw(props);
 const labels=nodes.filter(n=>n.type==='Pressable').map(n=>n.props.accessibilityLabel);
 for(const id of ['linked-paused','unlinked-active','saved'])assert.equal(labels.filter(x=>x===`Goal ${id}`).length,1);
 assert.ok(!labels.includes('Goal done'));assert.ok(!labels.includes('Goal cleared'));
 const delegated=nodes.find(n=>n.type==='View'&&Array.isArray(n.props.children)&&n.props.children[0]?.props?.children==='Delegated');
 assert.ok(delegated);assert.equal(delegated.props.children[1].length,1);assert.equal(delegated.props.children[1][0].props.title,'Goal linked-paused');
 assert.ok(!nodes.some(n=>n.type==='Text'&&['Goals','Unassigned','Legacy parent goals'].includes(n.props.children)));
 button(nodes,'Completed').props.onPress();nodes=h.draw(props);
 for(const id of ['done','cleared'])assert.ok(button(nodes,`Goal ${id}`));
 assert.ok(!button(nodes,'Goal linked-paused'));assert.ok(!nodes.some(n=>n.type==='Text'&&n.props.children==='Delegated'));
 button(nodes,'Current goals').props.onPress();props.registry.entries=[saved];nodes=h.draw(props);
 assert.ok(!nodes.some(n=>n.type==='Text'&&n.props.children==='Delegated'));
 props.registry.entries=[];nodes=h.draw(props);assert.ok(nodes.some(n=>n.type==='Text'&&n.props.children==='No goals yet'));
});

test('Assigned parent goals remain read-only and retain completed history',()=>{
 const h=harness();const goal={...entry('parent'),status:'paused'};
 let nodes=h.parent({goal,completed:[{...entry('old'),status:'completed'}],colors});
 assert.equal(nodes.find(n=>n.type==='SettingsSection').props.title,'Assigned');
 assert.ok(!button(nodes,'Start'));assert.ok(!button(nodes,'Resume'));assert.ok(!button(nodes,'Edit'));
 button(nodes,'Completed').props.onPress();nodes=h.parent({goal,completed:[{...entry('old'),status:'completed'}],colors});
 assert.ok(nodes.some(n=>n.type==='Text'&&n.props.children==='Goal old'));
 assert.deepEqual(h.parent({goal:null,completed:[],colors}),[]);
});
