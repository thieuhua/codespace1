import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { database } from '../test-support/d1.mjs';
import { submitTask,claimRun,runForToken,runTool,finishRun,receiveTaskMail,answerTask,cronTick,schedule,cancelTask,getTask } from '../src/tasks.js';

function fixture(t) {
  const {DB,sqlite}=database(t),sent=[],env={DB,MAIL_DOMAIN:'example.com'};
  sqlite.exec("INSERT INTO allowlist VALUES('a@example.com','*','now'),('b@example.com','*','now')");
  const send=async(_env,mail)=>{sent.push(mail);};
  const create=async()=> (await submitTask(env,{agent:'claude',owner:'a@example.com',prompt:'work'})).task;
  const claim=(agent='claude')=>claimRun(env,[agent]);
  const tool=async(run,name,body)=>runTool(env,await runForToken(env,run.run_token),name,body,send);
  const finish=(run,body={})=>finishRun(env,run.id,{ok:true,output:'stdout',session_id:'session',...body},send);
  const row=id=>sqlite.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  const incoming=(task,{sender=task.owner,msgId=100,headers=[],...mail}={})=>receiveTaskMail(env,{msgId,agent:task.agent,sender,
    mail:{inReplyTo:task.rfc_message_id,messageId:`<mail-${msgId}@example.com>`,subject:'Re: work',text:'yes',headerLines:headers,...mail}},send);
  const due=(id)=>{
    const until=new Date(Date.now()-1000).toISOString();
    sqlite.prepare("UPDATE tasks SET wait_until=?,wait_json=json_set(wait_json,'$.until',?) WHERE id=?").run(until,until,id);
    return until;
  };
  return {DB,sqlite,env,sent,send,create,claim,tool,finish,row,incoming,due};
}

test('P4 root ask only updates outcome; last question wins; blocks reply/spawn/await; finish and retries send once',async t=>{
  const f=fixture(t),task=await f.create(),run=await f.claim();
  assert.equal((await f.tool(run,'ask_user',{question:'first',timeout_seconds:60})).ok,true);
  assert.equal((await f.tool(run,'ask_user',{question:'last'})).ok,true);
  assert.equal(f.sent.length,0);assert.equal(f.row(task.id).status,'active');assert.equal(f.row(task.id).question_count,0);
  for(const [name,args] of [['reply',{text:'no'}],['spawn',{agent:'codex',prompt:'no'}],['await',{seconds:60}],['await',{ids:[1]}]]) {
    assert.equal((await f.tool(run,name,args)).code,409);
  }
  await Promise.all([f.finish(run,{finalize_note:' finalized'}),f.finish(run,{finalize_note:' finalized'})]);
  await f.finish(run,{finalize_note:' finalized'});
  assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/last finalized/);assert.doesNotMatch(f.sent[0].text,/first/);
  assert.equal(f.row(task.id).status,'waiting');assert.equal(JSON.parse(f.row(task.id).wait_json).mode,'user');
  assert.equal(f.row(task.id).wait_until,null);assert.equal(f.row(task.id).question_count,1);assert.equal(f.row(task.id).mail_count,1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM outbound_mails WHERE kind='question'").get().n,1);
});

test('P4 child ask is explicitly rejected',async t=>{
  const f=fixture(t);await f.create();const root=await f.claim();
  await f.tool(root,'spawn',{agent:'codex',prompt:'child'});
  const child=await f.claim('codex'),result=await f.tool(child,'ask_user',{question:'which?'});
  assert.equal(result.code,409);assert.match(result.error,/root email task only/);
});

for(const stop of ['cancelled','cancelled-result','failed','lost','expired']) test(`P4 ${stop} run never sends its question`,async t=>{
  const f=fixture(t),task=await f.create(),run=await f.claim();
  await f.tool(run,'ask_user',{question:'do not send'});
  if(stop==='cancelled') await cancelTask(f.env,task.id,task.owner,f.send);
  if(stop==='lost') {f.sqlite.prepare("UPDATE runs SET claimed_at='2000' WHERE id=?").run(run.id);await cronTick(f.env,f.send);}
  if(stop==='expired') f.sqlite.prepare("UPDATE tasks SET expires_at='2000' WHERE id=?").run(task.id);
  await f.finish(run,{ok:stop!=='failed',cancelled:stop==='cancelled-result'});
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM outbound_mails WHERE kind='question'").get().n,0);
  assert.equal(f.row(task.id).question_count,0);assert.ok(f.sent.every(m=>!m.text.includes('do not send')));
});

test('P4 ask -> mapped owner reply -> summary uses same task/session; wrong owner cannot wake it',async t=>{
  const f=fixture(t),task=await f.create(),run=await f.claim();
  await f.tool(run,'ask_user',{question:'choose?',timeout_seconds:60});await f.finish(run);
  const questionId=f.sent[0].messageId;
  const wrong=await f.incoming(task,{sender:'b@example.com',inReplyTo:questionId,msgId:101});
  assert.notEqual(wrong.id,task.id);assert.equal(f.row(task.id).status,'waiting');
  // Finish the unrelated root first so the next claim belongs to the answer.
  await f.finish(await f.claim());
  const answered=await f.incoming(task,{inReplyTo:questionId,msgId:102,text:'blue'});
  assert.equal(answered.id,task.id);assert.equal(f.row(task.id).wait_until,null);
  const next=await f.claim();assert.equal(next.task_id,task.id);assert.equal(next.resume_session,'session');
  assert.equal(next.events[0].kind,'mail');assert.match(next.events[0].payload_json,/blue/);
  await f.tool(next,'reply',{text:'summary: blue'});await f.finish(next);
  assert.equal(f.row(task.id).status,'done');assert.match(f.sent.at(-1).text,/summary: blue/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM outbound_mails WHERE task_id=?').get(task.id).n,2);
});

for(const [key,value] of [['Auto-Submitted','auto-replied'],['Auto-Submitted','auto-generated'],['X-Auto-Response-Suppress','All'],
  ['X-Auto-Response-Suppress','none'],['Precedence','bulk'],['Precedence','auto_reply'],['Precedence','list']]) {
  test(`P4 automatic ${key}: ${value} neither wakes task nor creates another`,async t=>{
    const f=fixture(t),task=await f.create(),run=await f.claim();
    await f.tool(run,'ask_user',{question:'choose?'});await f.finish(run);
    const headers=[{key:key.toUpperCase(),line:`${key}: ${value}`}];
    for(const inReplyTo of [f.sent[0].messageId,'<unknown@x>']) assert.equal((await f.incoming(task,{headers,inReplyTo})).status,'auto_suppressed');
    assert.equal(f.row(task.id).status,'waiting');assert.equal(await f.claim(),null);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tasks').get().n,1);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM events').get().n,1);
  });
}

test('P4 Auto-Submitted no is accepted and /status displays user/timer/child conditions',async t=>{
  const f=fixture(t),task=await f.create(),run=await f.claim();
  await f.tool(run,'ask_user',{question:'choose?',timeout_seconds:60});await f.finish(run);
  await f.incoming(task,{subject:'/status',msgId:20});
  assert.match(f.sent.at(-1).text,/user/);assert.match(f.sent.at(-1).text,/until .*Z/);
  await f.incoming(task,{headers:[{key:'auto-submitted',line:'Auto-Submitted: no'}]});
  assert.ok(await f.claim());
  // Status rendering uses the same JSON/time fields for every waiting mode.
  for(const wait of [{mode:'timer',until:'2099-01-01T00:00:00Z'},{mode:'all',ids:[99]}]) {
    f.sqlite.prepare("UPDATE tasks SET status='waiting',wait_json=?,wait_until=? WHERE id=?").run(JSON.stringify(wait),wait.until||null,task.id);
    await f.incoming(task,{subject:'/status',msgId:21});assert.match(f.sent.at(-1).text,new RegExp(wait.mode));
  }
});

for(const asking of [true,false]) test(`P4 ${asking?'ask_user timeout':'timer await'} wakes only when due with system timer event`,async t=>{
  const f=fixture(t),task=await f.create(),run=await f.claim();
  await f.tool(run,asking?'ask_user':'await',asking?{question:'choose?',timeout_seconds:60}:{seconds:60});await f.finish(run);
  assert.ok(f.row(task.id).wait_until);assert.equal((await cronTick(f.env,f.send)).timers,0);assert.equal(await f.claim(),null);
  const until=f.due(task.id);assert.equal((await cronTick(f.env,f.send)).timers,1);
  const next=await f.claim();assert.ok(next);assert.equal(f.row(task.id).wait_until,null);assert.equal(f.row(task.id).wait_json,null);
  const timer=next.events.find(e=>e.kind==='timer'),payload=JSON.parse(timer.payload_json);
  assert.equal(payload.source,'system');assert.equal(payload.wait_until,until);
  assert.equal(payload.text,asking?'người dùng chưa trả lời':'đã đến giờ hẹn');
  await cronTick(f.env,f.send);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM events WHERE kind='timer'").get().n,1);
});

test('P4 stale timer cannot wake a new user wait; early owner mail cancels timer',async t=>{
  const f=fixture(t),task=await f.create(),run=await f.claim();
  await f.tool(run,'await',{seconds:60});await f.finish(run);
  const oldUntil=f.due(task.id);
  await f.incoming(task);const next=await f.claim();
  assert.equal(f.row(task.id).wait_until,null);
  await f.tool(next,'ask_user',{question:'another question'});await f.finish(next);
  f.sqlite.prepare("INSERT INTO events(task_id,kind,payload_json,dedupe_key,created_at) VALUES(?,'timer',?,?, 'now')")
    .run(task.id,JSON.stringify({wait_until:oldUntil}),`timer:${task.id}:${oldUntil}`);
  assert.equal(await schedule(f.env,task.id),false);assert.equal(await f.claim(),null);assert.equal(f.row(task.id).status,'waiting');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM events WHERE kind='timer'").get().n,0);
});

test('P4 due timer from old wait cannot wake a replacement timer wait',async t=>{
  const f=fixture(t),task=await f.create(),run=await f.claim();
  await f.tool(run,'await',{seconds:60});await f.finish(run);const oldUntil=f.due(task.id);
  await f.incoming(task);const next=await f.claim();
  await f.tool(next,'await',{seconds:120});await f.finish(next);
  const current=f.row(task.id).wait_until;
  f.sqlite.prepare("INSERT INTO events(task_id,kind,payload_json,dedupe_key,created_at) VALUES(?,'timer',?,?,'now')")
    .run(task.id,JSON.stringify({wait_until:oldUntil}),`timer:${task.id}:${oldUntil}`);
  assert.equal(await schedule(f.env,task.id),false);assert.equal(await f.claim(),null);
  assert.equal(f.row(task.id).wait_until,current);
});

test('P4 owner mail cancels already admitted timer while owner run quota is full',async t=>{
  const f=fixture(t),task=await f.create(),run=await f.claim();
  await f.tool(run,'await',{seconds:60});await f.finish(run);f.due(task.id);
  const insert=f.sqlite.prepare('INSERT INTO command_receipts(sender,created_at) VALUES(?,?)');
  for(let i=0;i<29;i++)insert.run(task.owner,new Date().toISOString());
  await cronTick(f.env,f.send);assert.equal(f.row(task.id).status,'waiting');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM events WHERE kind='timer'").get().n,1);
  await f.incoming(task);assert.equal(f.row(task.id).wait_until,null);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM events WHERE kind='timer'").get().n,0);
  f.sqlite.exec('DELETE FROM command_receipts');await cronTick(f.env,f.send);
  const next=await f.claim();assert.deepEqual(next.events.map(e=>e.kind),['mail']);
});

test('P4 stale cron timer snapshot is guarded against owner mail arriving before insertion',async t=>{
  const f=fixture(t),task=await f.create(),run=await f.claim();
  await f.tool(run,'await',{seconds:60});await f.finish(run);f.due(task.id);
  const original=f.DB.prepare.bind(f.DB);let raced=false;
  f.DB.prepare=sql=>{
    const s=original(sql);
    if(sql.includes('FROM tasks INDEXED BY idx_tasks_timer')) {
      const all=s.all.bind(s);s.all=async()=>{const result=await all();if(!raced){raced=true;await f.incoming(task);}return result;};
    }
    return s;
  };
  await cronTick(f.env,f.send);
  const next=await f.claim();assert.equal(next.events.length,1);assert.equal(next.events[0].kind,'mail');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM events WHERE kind='timer'").get().n,0);
});

test('P4 atomic five-question budget, overwrites/retries do not spend extra, mail slot reserved for final answer',async t=>{
  const f=fixture(t),task=await f.create();let run=await f.claim();
  for(let i=0;i<5;i++) {
    const replies=await Promise.all([f.tool(run,'ask_user',{question:`q${i}`}),f.tool(run,'ask_user',{question:`q${i} updated`})]);
    assert.ok(replies.every(r=>r.ok));await f.finish(run);await f.finish(run);
    await f.incoming(task,{msgId:100+i,inReplyTo:f.sent.at(-1).messageId});run=await f.claim();
  }
  assert.equal(f.row(task.id).question_count,5);assert.equal(f.row(task.id).mail_count,5);
  assert.equal((await f.tool(run,'ask_user',{question:'sixth'})).code,409);
  await f.tool(run,'reply',{text:'finish without another question'});await f.finish(run);
  assert.equal(f.sent.length,6);
});

test('P4 question spends mail budget; notify cannot steal its final slot; reply at count 14 stays in same root',async t=>{
  const f=fixture(t),task=await f.create(),run=await f.claim();
  f.sqlite.prepare('UPDATE tasks SET mail_count=13 WHERE id=?').run(task.id);
  await f.tool(run,'ask_user',{question:'last allowed question'});
  assert.equal((await f.tool(run,'notify',{text:'steal slot'})).code,409);
  await f.finish(run);assert.equal(f.row(task.id).mail_count,14);
  assert.equal((await f.incoming(task,{inReplyTo:f.sent[0].messageId})).id,task.id);
  const answer=await f.claim();assert.equal((await f.tool(answer,'ask_user',{question:'over budget'})).code,409);
  await f.finish(answer);assert.equal(f.row(task.id).mail_count,15);assert.equal(f.sent.length,2);
});

test('P4 seconds validation, exclusive await variants and expiration bound',async t=>{
  const f=fixture(t),task=await f.create(),run=await f.claim();
  for(const n of [null,0,59,86401,60.5,'60']) for(const tool of ['await','ask_user']) {
    const result=await f.tool(run,tool,tool==='await'?{seconds:n}:{question:'q',timeout_seconds:n});assert.equal(result.code,400);
  }
  for(const body of [{seconds:60,ids:[2]},{seconds:60,mode:'all'},{},{ids:[2],seconds:undefined}]) {
    assert.ok((await f.tool(run,'await',body)).error);
  }
  // Extend TTL to test the upper boundary without losing milliseconds since creation.
  f.sqlite.prepare('UPDATE tasks SET expires_at=? WHERE id=?').run(new Date(Date.now()+86401000).toISOString(),task.id);
  assert.equal((await f.tool(run,'await',{seconds:86400})).ok,true);
  f.sqlite.prepare('UPDATE tasks SET expires_at=? WHERE id=?').run(new Date(Date.now()+59000).toISOString(),task.id);
  assert.equal((await f.tool(run,'await',{seconds:60})).code,409);
  assert.equal((await f.tool(run,'ask_user',{question:'q',timeout_seconds:60})).code,409);
});

test('P4 ask refuses the final task run so it cannot mail an unanswerable question',async t=>{
  const f=fixture(t),task=await f.create(),run=await f.claim();
  f.sqlite.prepare('UPDATE tasks SET run_count=max_runs WHERE id=?').run(task.id);
  assert.equal((await f.tool(run,'ask_user',{question:'no run left'})).code,409);
  assert.equal((await f.tool(run,'reply',{text:'final answer'})).ok,true);
  await f.finish(run);assert.equal(f.sent.length,1);assert.equal(f.row(task.id).status,'done');
  assert.equal(f.row(task.id).question_count,0);
});

test('P4 owner can wake a timer early at mail count 14 and use its final mail slot',async t=>{
  const f=fixture(t),task=await f.create(),run=await f.claim();
  f.sqlite.prepare('UPDATE tasks SET mail_count=14 WHERE id=?').run(task.id);
  await f.tool(run,'await',{seconds:60});await f.finish(run);
  assert.equal((await f.incoming(task)).id,task.id);assert.equal(f.row(task.id).wait_until,null);
  const next=await f.claim();assert.equal(next.task_id,task.id);await f.finish(next);
  assert.equal(f.row(task.id).mail_count,15);assert.equal(f.sent.length,1);
});

test('P4 answer_task validates owner/root/state; concurrent dedupe spends one owner receipt and resumes',async t=>{
  const f=fixture(t),task=await f.create(),run=await f.claim();
  assert.equal((await answerTask(f.env,task.id,task.owner,{text:'early'},f.send)).code,409);
  const {task_id:child}=await f.tool(run,'spawn',{agent:'codex',prompt:'child'});
  await f.tool(run,'ask_user',{question:'choose?',timeout_seconds:60});await f.finish(run);
  assert.equal((await answerTask(f.env,child,task.owner,{text:'x'},f.send)).code,409);
  assert.equal((await answerTask(f.env,task.id,'b@example.com',{text:'x'},f.send)).code,409);
  assert.equal((await answerTask(f.env,task.id,task.owner,{text:'',owner:'b@example.com'},f.send)).code,400);
  const answers=await Promise.all(Array.from({length:6},()=>answerTask(f.env,task.id,task.owner,{text:'blue'},f.send)));
  assert.ok(answers.every(r=>r.ok));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM command_receipts').get().n,1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM events WHERE kind='mail'").get().n,1);
  assert.equal(f.row(task.id).wait_until,null);
  const next=await f.claim();assert.equal(next.events[0].kind,'mail');assert.match(next.events[0].payload_json,/blue/);
  await f.tool(next,'reply',{text:'summary blue'});await f.finish(next);
  assert.match(f.sent.at(-1).text,/summary blue/);assert.equal((await answerTask(f.env,task.id,task.owner,{text:'late'},f.send)).code,409);
});

test('P4 answer owner quota rejects atomically and leaves waiting task/timer intact',async t=>{
  const f=fixture(t),task=await f.create(),run=await f.claim();
  await f.tool(run,'ask_user',{question:'q',timeout_seconds:60});await f.finish(run);
  const until=f.row(task.id).wait_until;
  const insert=f.sqlite.prepare('INSERT INTO command_receipts(sender,created_at) VALUES(?,?)');
  for(let i=0;i<29;i++)insert.run(task.owner,new Date().toISOString());
  assert.equal((await answerTask(f.env,task.id,task.owner,{text:'answer'},f.send)).code,429);
  assert.equal(f.row(task.id).wait_until,until);assert.equal(f.row(task.id).status,'waiting');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM events WHERE kind='mail'").get().n,0);
});

test('P4 cron limits timer admission per tick, index used, schema v6 is one-shot',async t=>{
  const f=fixture(t),tasks=[];
  for(let i=0;i<5;i++) {const task=await f.create(),run=await f.claim();await f.tool(run,'await',{seconds:60});await f.finish(run);f.due(task.id);tasks.push(task);}
  assert.equal((await cronTick(f.env,f.send)).timers,2);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM events WHERE kind='timer'").get().n,2);
  assert.equal((await cronTick(f.env,f.send)).timers,2);assert.equal((await cronTick(f.env,f.send)).timers,1);
  const detail=await getTask(f.env,tasks[0].id,tasks[0].owner);assert.ok(Object.hasOwn(detail.task,'wait_until'));
  const plan=f.sqlite.prepare("EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE status='waiting' AND wait_until<=?").all('2999');
  assert.match(JSON.stringify(plan),/idx_tasks_timer/);
  assert.throws(()=>f.sqlite.exec(readFileSync(new URL('../schema-v6.sql',import.meta.url),'utf8')),/duplicate column/);
});
