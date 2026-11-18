import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../test-support/d1.mjs';
import { submitTask, claimRun, runForToken, runTool, finishRun, receiveTaskMail, cronTick } from '../src/tasks.js';
import { buildRunPrompt } from '../../agent/run-prompt.mjs';

function fixture(t) {
  const { DB, sqlite } = database(t), sent=[], env={DB,MAIL_DOMAIN:'example.com'};
  sqlite.exec("INSERT INTO allowlist VALUES('a@example.com','*','now')");
  const send=async(_env,mail)=>{sent.push(mail);};
  const create=async()=> (await submitTask(env,{agent:'claude',owner:'a@example.com',prompt:'work'})).task;
  const claim=(agent='claude')=>claimRun(env,[agent]);
  const tool=async(run,name,body)=>runTool(env,await runForToken(env,run.run_token),name,body,send);
  const finish=(run,body={})=>finishRun(env,run.id,{ok:true,output:'stdout',session_id:'session',...body},send);
  const row=id=>sqlite.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  const incoming=(task,msgId=100)=>receiveTaskMail(env,{msgId,agent:task.agent,sender:task.owner,
    mail:{inReplyTo:task.rfc_message_id,messageId:`<mail-${msgId}@example.com>`,subject:'Re: work',text:'new information'}},send);
  return {DB,sqlite,env,sent,send,create,claim,tool,finish,row,incoming};
}

for(const mode of ['user','timer']) for(const limited of [false,true]) {
  test(`review 1: ${mode}, owner quota ${limited?'full':'available'}: queued mail atomically skips wait and survives finish retry`,async t=>{
    const f=fixture(t),task=await f.create(),run=await f.claim();
    f.sqlite.prepare('UPDATE tasks SET run_count=7,mail_count=13 WHERE id=?').run(task.id);
    assert.equal((await f.tool(run,mode==='user'?'ask_user':'await',mode==='user'?{question:'obsolete question',timeout_seconds:60}:{seconds:60})).ok,true);
    // Simulate a slow CLI: the requested timer is already due at finish.
    if(mode==='timer'&&limited) f.sqlite.prepare("UPDATE runs SET outcome_json=json_set(outcome_json,'$.wait.until',?) WHERE id=?")
      .run(new Date(Date.now()-1000).toISOString(),run.id);
    // Mail arrives after finishRun's initial read, immediately before its batch.
    const batch=f.DB.batch.bind(f.DB);let first=true,phaseOne;
    f.DB.batch=async statements=>{
      if(!first) return batch(statements);
      first=false;
      await f.incoming(task);
      if(limited) for(let i=0;i<29;i++) f.sqlite.prepare('INSERT INTO command_receipts(sender,created_at) VALUES(?,?)').run(task.owner,new Date().toISOString());
      const result=await batch(statements);
      phaseOne={...f.row(task.id)};
      return result;
    };
    assert.equal((await f.finish(run)).ok,true);
    assert.equal(phaseOne.status,'active');assert.equal(phaseOne.wait_json,null);assert.equal(phaseOne.wait_until,null);
    assert.equal(phaseOne.question_count,0);assert.equal(phaseOne.mail_count,13);
    assert.equal(phaseOne.max_runs,8);assert.equal(phaseOne.finished_at,null);
    await Promise.all([f.finish(run),f.finish(run)]);
    assert.equal(f.sent.length,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM outbound_mails').get().n,0);
    if(limited) {
      assert.equal(f.row(task.id).run_count,7);assert.equal(await f.claim(),null);
      await cronTick(f.env,f.send);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM events WHERE kind='timer'").get().n,0);
      f.sqlite.exec('DELETE FROM command_receipts');await cronTick(f.env,f.send);
    }
    const next=await f.claim();assert.equal(next.task_id,task.id);assert.equal(next.resume_session,'session');
    assert.equal(f.row(task.id).run_count,8);assert.equal(f.row(task.id).max_runs,8);
    assert.deepEqual(next.events.map(e=>e.kind),['mail']);assert.match(next.events[0].payload_json,/new information/);
    assert.deepEqual(next.skipped_waits.map(w=>({run_id:w.run_id,mode:w.mode})),[{run_id:run.id,mode}]);
    const prompt=buildRunPrompt(next,{dir:'safe',outbox:'safe/outbox'}),instructions=prompt.split('<<<UNTRUSTED_EVENT_')[0];
    assert.match(instructions,/hệ thống.*câu hỏi\/hẹn giờ.*đã bị bỏ vì có thư mới/);
    assert.match(instructions,/tự quyết định.*hỏi lại/);
    await f.finish(run);assert.equal(f.sent.length,0);
    // No phantom question spent the last mail slot or caused an early fork.
    assert.equal((await f.incoming(task,101)).id,task.id);
    await f.finish(next);assert.equal(f.row(task.id).mail_count,14);
    const later=await f.claim();assert.deepEqual(later.skipped_waits,[]);
  });
}

for(const mode of ['user','timer']) test(`review 1: ${mode} skipped wait rolls back with the entire finish batch`,async t=>{
  const f=fixture(t),task=await f.create(),run=await f.claim();
  await f.tool(run,mode==='user'?'ask_user':'await',mode==='user'?{question:'q'}:{seconds:60});
  await f.incoming(task);
  f.sqlite.exec(`CREATE TRIGGER abort_finish BEFORE UPDATE ON tasks
    WHEN EXISTS(SELECT 1 FROM runs WHERE task_id=OLD.id AND result_hash IS NOT NULL)
    BEGIN SELECT RAISE(ABORT,'injected finish failure'); END`);
  await assert.rejects(f.finish(run),/injected finish failure/);
  const rolledBack=f.sqlite.prepare('SELECT * FROM runs WHERE id=?').get(run.id);
  assert.equal(rolledBack.status,'running');assert.equal(rolledBack.result_hash,null);
  assert.equal(JSON.parse(rolledBack.outcome_json).skipped_wait,undefined);
  assert.equal(f.row(task.id).question_count,0);assert.equal(f.row(task.id).mail_count,0);
  assert.equal(f.sqlite.prepare("SELECT run_id FROM events WHERE kind='mail'").get().run_id,null);
  f.sqlite.exec('DROP TRIGGER abort_finish');await f.finish(run);
  const next=await f.claim();assert.equal(next.skipped_waits[0].mode,mode);assert.equal(f.sent.length,0);
});

test('review 1: agent may ask again after skipped question; later mail wakes the new wait normally',async t=>{
  const f=fixture(t),task=await f.create(),run=await f.claim();
  await f.tool(run,'ask_user',{question:'old question'});await f.incoming(task);await f.finish(run);
  const next=await f.claim();assert.equal((await f.tool(next,'ask_user',{question:'reconsidered question'})).ok,true);
  await f.finish(next);await f.finish(run);
  assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/reconsidered question/);
  assert.doesNotMatch(f.sent[0].text,/old question/);assert.equal(f.row(task.id).question_count,1);
  assert.equal(f.row(task.id).status,'waiting');assert.equal(f.row(task.id).wait_until,null);
  assert.equal((await f.incoming(task,101)).id,task.id);
  const answered=await f.claim();assert.deepEqual(answered.skipped_waits,[]);await f.finish(answered);
  assert.equal(f.row(task.id).status,'done');assert.equal(f.sent.length,2);
});

for(const tool of ['ask_user','await']) for(const prior of ['spawn','ids','timer','user']) {
  test(`review 2: ${tool} refuses after ${prior} without replacing outcome wait/children`,async t=>{
    const f=fixture(t),task=await f.create(),run=await f.claim();
    let child;
    if(['spawn','ids'].includes(prior)) {
      child=(await f.tool(run,'spawn',{agent:'codex',prompt:'child'})).task_id;
      if(prior==='ids') assert.equal((await f.tool(run,'await',{ids:[child]})).ok,true);
    } else assert.equal((await f.tool(run,prior==='user'?'ask_user':'await',prior==='user'?{question:'first'}:{seconds:60})).ok,true);
    const before=f.sqlite.prepare('SELECT outcome_json FROM runs WHERE id=?').get(run.id).outcome_json;
    const result=await f.tool(run,tool,tool==='ask_user'?{question:'overwrite'}:{seconds:60});
    assert.equal(result.code,409);assert.match(result.error,/wait|spawn|children/);
    assert.equal(f.sqlite.prepare('SELECT outcome_json FROM runs WHERE id=?').get(run.id).outcome_json,before);
    await f.finish(run);
    if(child) {
      assert.deepEqual(JSON.parse(f.row(task.id).wait_json),{mode:'all',ids:[child]});
      assert.equal(f.row(child).status,'active');assert.equal(f.sent.length,0);
      await f.finish(await f.claim('codex'));const summary=await f.claim();
      assert.equal(summary.events[0].kind,'child_result');await f.finish(summary);
      assert.equal(f.row(child).status,'done');assert.equal(f.row(task.id).status,'done');
    }
  });
}

for(const mode of ['all','any']) test(`review 2: early mail retains live ${mode} children across runs and rejects question/timer`,async t=>{
  const f=fixture(t),task=await f.create(),run=await f.claim();
  const child=(await f.tool(run,'spawn',{agent:'codex',prompt:'child'})).task_id;
  assert.equal((await f.tool(run,'await',{ids:[child],mode})).ok,true);await f.finish(run);
  await f.incoming(task);const next=await f.claim(),wait=f.row(task.id).wait_json;
  for(const [name,args] of [['ask_user',{question:'overwrite'}],['await',{seconds:60}]]) {
    const result=await f.tool(next,name,args);assert.equal(result.code,409);assert.match(result.error,/children/);
    assert.equal(f.row(task.id).wait_json,wait);
  }
  await f.finish(next);assert.equal(f.row(task.id).wait_json,wait);assert.equal(f.row(task.id).status,'waiting');
  assert.equal(f.row(child).status,'active');assert.equal(f.sent.length,0);
  await f.finish(await f.claim('codex'));const summary=await f.claim();
  assert.equal(summary.events[0].kind,'child_result');await f.finish(summary);
  assert.equal(f.row(task.id).status,'done');assert.equal(f.row(child).status,'done');
});

for(const name of ['ask_user','await']) test(`review 3: ${name} refuses final run and lets agent reply successfully`,async t=>{
  const f=fixture(t),task=await f.create(),run=await f.claim();
  f.sqlite.prepare('UPDATE tasks SET run_count=max_runs WHERE id=?').run(task.id);
  const result=await f.tool(run,name,name==='ask_user'?{question:'impossible answer'}:{seconds:60});
  assert.equal(result.code,409);assert.match(result.error,/run budget/);
  assert.equal((await f.tool(run,'reply',{text:'final answer'})).ok,true);await f.finish(run);
  assert.equal(f.row(task.id).status,'done');assert.equal(f.row(task.id).wait_until,null);
  assert.equal(f.row(task.id).question_count,0);assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/final answer/);
});
