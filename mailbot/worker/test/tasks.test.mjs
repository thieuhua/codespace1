import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../test-support/d1.mjs';
import { submitTask, schedule, claimRun, finishRun, runForToken, runTool, cancelTask, completeTask, receiveTaskMail, cronTick, mapMail, getTask } from '../src/tasks.js';

function setup(t) {
  const {DB,sqlite}=database(t),sent=[];
  sqlite.exec("INSERT INTO allowlist VALUES('a@example.com','*','now'),('b@example.com','*','now')");
  const env={DB,MAIL_DOMAIN:'example.com'};
  const send=async(_env,mail)=>{sent.push(mail);};
  const create=async(agent='claude',extra={})=>{
    const result=await submitTask(env,{agent,owner:'a@example.com',prompt:'play rock paper scissors',...extra});
    assert.ok(result.task,JSON.stringify(result)); return result.task;
  };
  const claim=(agent='claude')=>claimRun(env,[agent]);
  const tool=async(run,name,args)=>{
    const scoped=await runForToken(env,run.run_token);
    assert.ok(scoped); return runTool(env,scoped,name,args,send);
  };
  const finish=(run,body={})=>finishRun(env,run.id,{ok:true,output:'stdout',session_id:'session',...body},send);
  const row=(table,id)=>sqlite.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  return {DB,sqlite,env,sent,send,create,claim,tool,finish,row};
}

test('D1 concurrent schedules/claims never duplicate runs or steal queued events; finish saves session before next claim',async t=>{
  const f=setup(t),task=await f.create();
  await Promise.all(Array.from({length:8},()=>schedule(f.env,task.id)));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM runs').get().n,1);
  const claims=await Promise.all([f.claim(),f.claim()]);
  assert.equal(claims.filter(Boolean).length,1);
  const run=claims.find(Boolean);
  await receiveTaskMail(f.env,{agent:'claude',sender:task.owner,msgId:100,mail:{messageId:'<next@x>',inReplyTo:task.rfc_message_id,subject:'more',text:'new requirement'}},f.send);
  const e=f.sqlite.prepare("SELECT * FROM events WHERE kind='mail'").get();
  assert.equal(e.run_id,null);
  await Promise.all([schedule(f.env,task.id),f.finish(run)]);
  const next=await f.claim(); assert.ok(next); assert.equal(next.resume_session,'session');
  assert.equal(next.events.length,1); assert.equal(next.events[0].id,e.id);
  await f.finish(next); assert.equal(await f.claim(),null);
  await schedule(f.env,task.id); assert.equal(await f.claim(),null);
});

test('full rock paper scissors: root spawns two children + await -> exactly one summary mail (children finish first)',async t=>{
  const f=setup(t),root=await f.create(),parent=await f.claim();
  const c1=await f.tool(parent,'spawn',{agent:'codex',prompt:'choose rock'});
  const c2=await f.tool(parent,'spawn',{agent:'agy',prompt:'choose scissors'});
  const r1=await f.claim('codex'),r2=await f.claim('agy');
  assert.notEqual(r1.task_id,r2.task_id);
  assert.equal((await f.tool(r1,'notify',{text:'no'})).code,409);
  await f.tool(r1,'reply',{text:'rock'});
  await f.finish(r1,{output:'irrelevant stdout'}); await f.finish(r2,{output:'scissors'});
  assert.equal((await f.tool(parent,'await',{ids:[c1.task_id,c2.task_id]})).ok,true);
  await f.finish(parent,{output:'waiting',session_id:'root-session'});
  assert.equal(f.sent.length,0);
  const summary=await f.claim(); assert.equal(summary.task_id,root.id); assert.equal(summary.resume_session,'root-session');
  assert.equal(summary.events.filter(e=>e.kind==='child_result').length,2);
  assert.match(summary.events.map(e=>e.payload_json).join('\n'),/rock/);
  await f.tool(summary,'reply',{text:'discard'}); await f.tool(summary,'reply',{text:'Rock beats scissors: root summary.'});
  const body={ok:true,output:'fallback',session_id:'root-session'};
  await finishRun(f.env,summary.id,body,f.send); await finishRun(f.env,summary.id,body,f.send);
  assert.equal(f.sent.length,1); assert.match(f.sent[0].text,/Rock beats scissors/); assert.doesNotMatch(f.sent[0].text,/fallback/);
  assert.equal(f.row('tasks',root.id).status,'done');
});

for(const reason of ['failed','cancelled','expired','lost']) test(`child ${reason} always delivers one result and wakes parent`,async t=>{
  const f=setup(t),root=await f.create(),parent=await f.claim();
  const {task_id:child}=await f.tool(parent,'spawn',{agent:'codex',prompt:'child'});
  await f.tool(parent,'await',{ids:[child]}); await f.finish(parent);
  const run=await f.claim('codex');
  if(reason==='failed') await f.finish(run,{ok:false,output:'CLI failed'});
  if(reason==='cancelled') await cancelTask(f.env,child,root.owner);
  if(reason==='expired') {f.sqlite.prepare("UPDATE tasks SET expires_at='2000' WHERE id=?").run(child);await cronTick(f.env,f.send);}
  if(reason==='lost') {f.sqlite.prepare('UPDATE tasks SET lost_count=1 WHERE id=?').run(child);f.sqlite.prepare("UPDATE runs SET claimed_at='2000' WHERE id=?").run(run.id);await cronTick(f.env,f.send);}
  await completeTask(f.env,{taskId:child,status:'failed',result:'duplicate'});
  const next=await f.claim(); assert.ok(next);assert.equal(next.task_id,root.id);
  assert.equal(next.events.filter(e=>e.kind==='child_result').length,1);
  assert.equal(f.sent.length,0);
});

test('await only direct undelivered children; any leaves previous children cancellable at root completion',async t=>{
  const f=setup(t),root=await f.create(),run=await f.claim();
  const a=await f.tool(run,'spawn',{agent:'codex',prompt:'a'}),b=await f.tool(run,'spawn',{agent:'agy',prompt:'b'});
  assert.equal((await f.tool(run,'await',{ids:[root.id]})).code,409);
  assert.equal((await f.tool(run,'await',{ids:[a.task_id,a.task_id]})).code,400);
  await f.tool(run,'await',{mode:'any',ids:[a.task_id,b.task_id]}); await f.finish(run);
  const ar=await f.claim('codex'),br=await f.claim('agy');await f.finish(ar);
  const next=await f.claim();
  assert.equal((await f.tool(next,'await',{ids:[a.task_id]})).code,409);
  await f.finish(next,{output:'enough'});
  assert.equal(f.row('tasks',root.id).status,'done');assert.equal(f.row('tasks',b.task_id).status,'cancelled');
  assert.equal(await runForToken(f.env,br.run_token),null);
  assert.equal(f.row('runs',br.id).cancel_requested,1);
});

test('auto-await is limited to children spawned in current run and handles early completion',async t=>{
  const f=setup(t),root=await f.create(),p=await f.claim();
  await f.tool(p,'spawn',{agent:'codex',prompt:'child'});
  await f.finish(await f.claim('codex'));
  await f.finish(p);
  assert.ok(await f.claim());assert.equal(f.sent.length,0);
  assert.equal(f.row('tasks',root.id).status,'active');
});

test('cancel waiting tree is synchronous, owner scoped and revokes all running/pending tokens',async t=>{
  const f=setup(t),root=await f.create(),p=await f.claim();
  const c=await f.tool(p,'spawn',{agent:'codex',prompt:'child'}),cr=await f.claim('codex');
  const g=await f.tool(cr,'spawn',{agent:'agy',prompt:'grandchild'}),gr=await f.claim('agy');
  await f.finish(p); assert.equal(f.row('tasks',root.id).status,'waiting');
  assert.equal((await cancelTask(f.env,root.id,'b@example.com')).code,404);
  await cancelTask(f.env,root.id,root.owner);
  for(const id of [root.id,c.task_id,g.task_id]) assert.equal(f.row('tasks',id).status,'cancelled');
  for(const r of [cr,gr]) {assert.equal(await runForToken(f.env,r.run_token),null);assert.equal(f.row('runs',r.id).cancel_requested,1);}
  assert.equal(await f.claim(),null);
  const late=await f.finish(cr,{attachments:[{filename:'partial',mime_type:'text/plain',b64_lines:'YQ=='}]});
  assert.equal(late.ignored,true);assert.equal(f.row('tasks',c.task_id).session_id,null);
});

test('mapping uses owner+agent+root, nearest RFC candidate; tag switch/new/failed create new task, done reopens with budget',async t=>{
  const f=setup(t),first=await f.create('claude',{project:'demo'}),run=await f.claim();await f.finish(run);
  const mail={messageId:'<reply@x>',inReplyTo:f.sent[0].messageId,subject:'follow',text:'follow'};
  assert.equal(await mapMail(f.env,{sender:'b@example.com',agent:'claude',mail}),null);
  assert.equal(await mapMail(f.env,{sender:first.owner,agent:'codex',mail}),null);
  f.sqlite.prepare("UPDATE tasks SET expires_at='2000',run_count=8 WHERE id=?").run(first.id);
  const resumed=await receiveTaskMail(f.env,{sender:first.owner,agent:'claude',msgId:2,mail},f.send);
  assert.equal(resumed.id,first.id);assert.equal(f.row('tasks',first.id).max_runs,16);
  assert.ok(f.row('tasks',first.id).expires_at>'2026');
  const next=await f.claim();assert.equal(next.resume_session,'session');await f.finish(next);
  const switched=await receiveTaskMail(f.env,{sender:first.owner,agent:'claude',tag:'other',msgId:3,mail:{...mail,messageId:'<newtag@x>'}},f.send);
  assert.notEqual(switched.id,first.id);assert.equal(f.row('tasks',switched.id).project,'other');
  const fresh=await receiveTaskMail(f.env,{sender:first.owner,agent:'claude',msgId:4,mail:{...mail,subject:'/new task'}},f.send);
  assert.notEqual(fresh.id,first.id); assert.equal((await f.claim()).resume_session,null);
  const other=await f.create();
  assert.equal((await mapMail(f.env,{sender:first.owner,agent:'claude',mail:{inReplyTo:other.rfc_message_id,references:first.rfc_message_id}})).id,other.id);
  await receiveTaskMail(f.env,{sender:first.owner,agent:'claude',msgId:99,mail:{...mail,messageId:'<reopen@x>'}},f.send);
  await completeTask(f.env,{taskId:first.id,status:'failed',result:'error'});
  const after=await receiveTaskMail(f.env,{sender:first.owner,agent:'claude',msgId:5,mail},f.send);assert.notEqual(after.id,first.id);
});

test('rate admission and tree budgets are atomic; continuation waits for cron instead of losing summary',async t=>{
  const f=setup(t),root=await f.create(),parent=await f.claim();
  const children=await Promise.all(Array.from({length:7},()=>f.tool(parent,'spawn',{agent:'codex',prompt:'child'})));
  assert.equal(children.filter(c=>c.task_id).length,3);assert.equal(f.row('tasks',root.id).tree_count,4);
  assert.equal(f.row('tasks',root.id).child_count,3);
  const cids=children.filter(c=>c.task_id).map(c=>c.task_id);
  await f.tool(parent,'await',{ids:cids});await f.finish(parent);
  for(let i=0;i<3;i++) await f.finish(await f.claim('codex'));
  // Fill quota before the root continuation can be scheduled, then return it to queue.
  const pending=f.sqlite.prepare("SELECT id FROM runs WHERE task_id=? AND status='pending'").get(root.id);
  f.sqlite.prepare('UPDATE events SET run_id=NULL WHERE run_id=?').run(pending.id);
  f.sqlite.prepare('DELETE FROM runs WHERE id=?').run(pending.id);
  f.sqlite.prepare('UPDATE tasks SET run_count=run_count-1 WHERE id=?').run(root.id);
  const n=f.sqlite.prepare('SELECT COUNT(*) n FROM runs').get().n;
  for(let i=n;i<30;i++) f.sqlite.prepare('INSERT INTO command_receipts(sender,created_at) VALUES(?,?)').run(root.owner,new Date().toISOString());
  assert.equal(await schedule(f.env,root.id),false);
  assert.equal((await submitTask(f.env,{agent:'agy',owner:root.owner,prompt:'new'})).code,429);
  assert.equal(f.sent.length,0);
  f.sqlite.prepare("UPDATE command_receipts SET created_at='2000'").run();
  await cronTick(f.env,f.send);const summary=await f.claim();assert.ok(summary);await f.finish(summary,{output:'summary'});assert.equal(f.sent.length,1);
});

test('spawn rate rejection creates no child/counter; global root run admission never exceeds 30',async t=>{
  const f=setup(t),root=await f.create(),r=await f.claim();
  for(let i=0;i<29;i++) f.sqlite.prepare('INSERT INTO command_receipts(sender,created_at) VALUES(?,?)').run(root.owner,new Date().toISOString());
  assert.equal((await f.tool(r,'spawn',{agent:'agy',prompt:'x'})).code,429);
  assert.equal(f.row('tasks',root.id).tree_count,1);assert.equal(f.row('tasks',root.id).child_count,0);
  f.sqlite.prepare('DELETE FROM command_receipts').run();
  const results=await Promise.all(Array.from({length:35},()=>submitTask(f.env,{agent:'agy',owner:root.owner,prompt:'x'})));
  assert.equal(results.filter(x=>x.task).length,29);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM runs').get().n,30);
});

test('finish phase 1 survives mail error/retry; concurrent retries send once and reject mismatched attachments/result',async t=>{
  const f=setup(t);await f.create();const r=await f.claim();
  const body={ok:true,output:'done',attachments:[{filename:'a.txt',mime_type:'text/plain',b64_lines:'YQ=='}]};
  let fail=true;
  const send=async(...args)=>{if(fail)throw new Error('send failed');await f.send(...args);};
  await assert.rejects(finishRun(f.env,r.id,body,send),/send failed/);
  assert.equal(f.row('runs',r.id).status,'done');assert.equal(f.sent.length,0);
  fail=false;await Promise.all(Array.from({length:5},()=>finishRun(f.env,r.id,body,send)));
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].attachments.length,1);
  assert.equal((await finishRun(f.env,r.id,{...body,output:'changed'},send)).code,409);
  assert.equal((await finishRun(f.env,r.id,{...body,attachments:[]},send)).code,409);
  assert.equal(f.sqlite.prepare('SELECT mail_count FROM tasks').get().mail_count,1);
});

test('run_lost never reclaims; records outcome, rotates run/token and only one consecutive recovery',async t=>{
  const f=setup(t),root=await f.create(),r=await f.claim();
  const child=await f.tool(r,'spawn',{agent:'codex',prompt:'child'});await f.tool(r,'notify',{text:'progress'});
  f.sqlite.prepare("UPDATE runs SET claimed_at='2000' WHERE id=?").run(r.id);
  await cronTick(f.env,f.send);
  assert.equal(f.row('runs',r.id).status,'failed');assert.equal(await runForToken(f.env,r.run_token),null);
  const next=await f.claim();assert.notEqual(next.id,r.id);
  const lost=JSON.parse(next.events.find(e=>e.kind==='run_lost').payload_json);
  assert.deepEqual(lost.outcome.spawned,[child.task_id]);assert.equal(lost.outcome.notifications.length,1);
  assert.equal((await f.finish(r)).ignored,true);
  f.sqlite.prepare("UPDATE runs SET claimed_at='2000' WHERE id=?").run(next.id);await cronTick(f.env,f.send);
  assert.equal(f.row('tasks',root.id).status,'failed');assert.equal(f.row('tasks',child.task_id).status,'cancelled');
  assert.equal(await f.claim(),null);
});

test('run/mail ceilings and task TTL use terminal path; cron bounded, mail persisted before send',async t=>{
  const f=setup(t),root=await f.create(),r=await f.claim();
  f.sqlite.prepare('UPDATE tasks SET mail_count=14 WHERE id=?').run(root.id);
  await Promise.all(Array.from({length:6},()=>f.tool(r,'notify',{text:'progress'})));
  assert.equal(f.row('tasks',root.id).mail_count,14);assert.equal(f.sent.length,0);
  for(let i=0;i<8;i++) await f.create('agy');
  f.sqlite.prepare("UPDATE tasks SET expires_at='2000' WHERE id!=?").run(root.id);
  let sent=0;
  await cronTick(f.env,async(_e,m)=>{
    sent++;const outbound=f.sqlite.prepare('SELECT * FROM outbound_mails WHERE message_id=?').get(m.messageId);
    assert.equal(outbound.status,'sending');assert.equal(f.row('tasks',outbound.task_id).status,'failed');
  });
  assert.equal(sent,1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM tasks WHERE status='failed'").get().n,1);
});

test('untrusted data caps, child outbox metadata and unsupported/root-only tools',async t=>{
  const f=setup(t),root=await f.create(),r=await f.claim();
  assert.equal((await f.tool(r,'reply',{text:'hello',files:['secret']})).code,400);
  assert.equal((await f.tool(r,'spawn',{agent:'codex',prompt:'x',project:'other'})).code,400);
  await f.tool(r,'spawn',{agent:'codex',prompt:'x'});await f.finish(r);
  const child=await f.claim('codex');
  assert.equal((await f.tool(child,'ask_user',{question:'q'})).code,409);
  await f.finish(child,{output:'\u0000'.repeat(200000),attachments:[{filename:'child.txt',mime_type:'text/plain',b64_lines:'YQ=='}]});
  const summary=await f.claim(),event=summary.events.find(e=>e.kind==='child_result');
  assert.ok(event.payload_json.length<=32768);assert.match(event.payload_json,/child.txt/);
  assert.equal(f.sent.length,0);
  const detail=await getTask(f.env,child.task_id,root.owner);assert.equal(detail.runs[0].output.length,200000);
  assert.equal(Object.hasOwn(detail.runs[0],'token_hash'),false);
});

test('auto-submitted/suppress mail never creates or reopens tasks; status/cancel share run budget',async t=>{
  const f=setup(t),root=await f.create(),run=await f.claim();await f.finish(run);
  const mail={subject:'follow',text:'x',inReplyTo:root.rfc_message_id,headerLines:[{key:'auto-submitted',line:'Auto-Submitted: auto-replied'}]};
  assert.equal((await receiveTaskMail(f.env,{agent:'claude',sender:root.owner,msgId:2,mail},f.send)).status,'auto_suppressed');
  assert.equal(f.row('tasks',root.id).status,'done');
  await receiveTaskMail(f.env,{agent:'claude',sender:root.owner,msgId:3,mail:{subject:'/status'}},f.send);
  assert.match(f.sent.at(-1).text,/done/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM command_receipts').get().n,1);
  const active=await f.create();
  for(let i=0;i<30;i++) f.sqlite.prepare('INSERT INTO command_receipts(sender,created_at) VALUES(?,?)').run(root.owner,new Date().toISOString());
  const res=await receiveTaskMail(f.env,{agent:'claude',sender:root.owner,msgId:4,mail:{subject:`/cancel=${active.id}`}},f.send);
  assert.equal(res.status,'command_suppressed');assert.equal(f.row('tasks',active.id).status,'cancelled');
});

test('parallel grandchildren reserve the shared root tree budget and reject depth overflow',async t=>{
  const f=setup(t),root=await f.create(),p=await f.claim();
  for(let i=0;i<3;i++) await f.tool(p,'spawn',{agent:'codex',prompt:'branch'});
  const branches=[];for(let i=0;i<3;i++) branches.push(await f.claim('codex'));
  const results=await Promise.all(branches.flatMap(r=>Array.from({length:3},()=>f.tool(r,'spawn',{agent:'agy',prompt:'leaf'}))));
  assert.equal(results.filter(r=>r.task_id).length,4);
  assert.equal(f.row('tasks',root.id).tree_count,8);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tasks WHERE root_id=?').get(root.id).n,8);
  assert.equal((await f.tool(await f.claim('agy'),'spawn',{agent:'claude',prompt:'too deep'})).code,409);
});

test('await all does not wake early; child rate reservation succeeds before quota then runs to completion',async t=>{
  const f=setup(t),root=await f.create(),p=await f.claim();
  const a=await f.tool(p,'spawn',{agent:'codex',prompt:'a'}),b=await f.tool(p,'spawn',{agent:'agy',prompt:'b'});
  await f.tool(p,'await',{ids:[a.task_id,b.task_id]});await f.finish(p);
  await f.finish(await f.claim('codex'));assert.equal(await f.claim(),null);assert.equal(f.row('tasks',root.id).status,'waiting');
  await f.finish(await f.claim('agy'));assert.ok(await f.claim());
});

test('cancel without ID handles every owner root/waiting child atomically but leaves other owners intact',async t=>{
  const f=setup(t),one=await f.create(),p=await f.claim();await f.tool(p,'spawn',{agent:'codex',prompt:'child'});await f.finish(p);
  const two=await f.create('agy'),other=await f.create('agy',{owner:'b@example.com'});
  await cancelTask(f.env,null,one.owner);
  assert.equal(f.row('tasks',one.id).status,'cancelled');assert.equal(f.row('tasks',two.id).status,'cancelled');
  assert.equal(f.row('tasks',other.id).status,'active');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM tasks WHERE owner=? AND status IN ('active','waiting')").get(one.owner).n,0);
});

test('run budget exhaustion completes child and root, lost recovery counts as another run; invalid sessions never resume',async t=>{
  const f=setup(t),root=await f.create(),p=await f.claim();
  const c=await f.tool(p,'spawn',{agent:'codex',prompt:'child'});await f.finish(p);
  const child=await f.claim('codex');
  f.sqlite.prepare('UPDATE tasks SET max_runs=1 WHERE id=?').run(c.task_id);
  f.sqlite.prepare("UPDATE runs SET claimed_at='2000' WHERE id=?").run(child.id);
  await cronTick(f.env,f.send);assert.equal(f.row('tasks',c.task_id).status,'failed');
  const next=await f.claim();assert.ok(next);
  await f.finish(next,{session_id:'--bad session'});assert.equal(f.row('tasks',root.id).session_id,null);
});

test('claim truncates payload in SQL and batches excess events without attaching them to running run',async t=>{
  const f=setup(t),root=await f.create(),p=await f.claim();
  for(let i=0;i<140;i++) f.sqlite.prepare("INSERT INTO events(task_id,kind,payload_json,dedupe_key,created_at) VALUES(?,'mail',?,?,?)")
    .run(root.id,JSON.stringify({text:'x'.repeat(10000)}),`mass:${i}`,new Date().toISOString());
  await f.finish(p);
  const next=await f.claim();assert.equal(next.events.length,128);
  assert.ok(next.events.reduce((n,e)=>n+e.payload_json.length,0)<=150000);assert.ok(next.events.some(e=>e.truncated));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM events WHERE run_id IS NULL').get().n,12);
  await f.finish(next);const final=await f.claim();assert.equal(final.events.length,12);
});
