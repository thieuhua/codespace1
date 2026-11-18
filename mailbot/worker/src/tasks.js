import { AGENTS, isAllowed, tokenHash, extractPrompt } from './mailbot.js';
import { parseSubject, COMMAND_HELP } from './subject.js';
import { validateAttachments } from './mime.js';

const SID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LIVE = "('active','waiting')";
const TERMINAL = "('done','failed','cancelled')";
const nowISO = () => new Date().toISOString();
const hourISO = () => new Date(Date.now() - 3600000).toISOString();
const expiry = () => new Date(Date.now() + 86400000).toISOString();
const fail = (error, code = 400) => ({ error, code });
const ids = (s) => String(s || '').match(/<[^<>\s]+>/g) || [];
const domain = (env) => env.MAIL_DOMAIN || 'xuanthieu.site';
const validText = (s) => typeof s === 'string' && !!s.trim() && s.length <= 200000;
const stmt = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const timerMatches = (task, event) => `${event}.kind='timer' AND ${task}.wait_until IS NOT NULL AND json_extract(${event}.payload_json,'$.wait_until')=${task}.wait_until AND ${task}.wait_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND json_extract(${task}.wait_json,'$.mode') IN ('user','timer')`;
const wakeEvent = (task, event) => `(${event}.kind IN ('mail','run_lost') OR (${timerMatches(task,event)}))`;
// Used only inside SQL statements that serialize the reservation with its INSERT.
const budget = (owner, hour) => `((SELECT COUNT(*) FROM runs br JOIN tasks bt ON bt.id=br.task_id WHERE bt.owner=${owner} AND br.created_at>${hour}) + (SELECT COUNT(*) FROM command_receipts WHERE sender=${owner} AND created_at>${hour}))`;
export const publicRun = ({ token_hash, ...run }) => run;
export const liveMessages = `SELECT e.message_id FROM events e JOIN tasks t ON t.id=e.task_id LEFT JOIN runs r ON r.id=e.run_id WHERE t.status IN ${LIVE} AND e.message_id IS NOT NULL AND (e.run_id IS NULL OR r.status IN ('pending','running') OR EXISTS(SELECT 1 FROM events l LEFT JOIN runs lr ON lr.id=l.run_id WHERE l.task_id=e.task_id AND l.kind='run_lost' AND json_extract(l.payload_json,'$.run_id')=e.run_id AND (l.run_id IS NULL OR lr.status IN ('pending','running'))))`;

// A fresh schedule_key scopes event assignment even if INSERT changes() is zero.
// The entire batch is atomic: nobody can claim until session/wait/counters agree.
export async function schedule(env, taskId, send) {
  const key = crypto.randomUUID(), now = nowISO();
  const exhausted=completionBatch(env,{taskId,status:'failed',result:'Run budget exhausted',key:`budget-${key}`,
    guard:`run_count>=max_runs AND NOT EXISTS(SELECT 1 FROM runs WHERE task_id=tasks.id AND status IN ('pending','running'))`});
  const result = await env.DB.batch([
    // A timer belongs to one wait condition. Drop undelivered obsolete timers
    // before testing the queue, so they cannot wake or keep a task alive.
    stmt(env, `DELETE FROM events WHERE task_id=?1 AND kind='timer' AND run_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.id=events.task_id AND (${timerMatches('t','events')}))`, taskId),
    stmt(env, `INSERT INTO runs(task_id,schedule_key,created_at,boundary)
      SELECT t.id,?2,?3,?4 FROM tasks t
      WHERE t.id=?1 AND t.status IN ${LIVE} AND t.expires_at>?3 AND t.run_count<t.max_runs
      AND EXISTS(SELECT 1 FROM events e WHERE e.task_id=t.id AND e.run_id IS NULL)
      AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.task_id=t.id AND r.status IN ('pending','running'))
      AND (t.status='active' OR EXISTS(SELECT 1 FROM events e WHERE e.task_id=t.id AND e.run_id IS NULL AND ${wakeEvent('t','e')})
        OR (json_extract(t.wait_json,'$.mode')='all' AND NOT EXISTS(
          SELECT 1 FROM json_each(t.wait_json,'$.ids') j JOIN tasks c ON c.id=j.value WHERE c.status NOT IN ${TERMINAL}))
        OR (json_extract(t.wait_json,'$.mode')='any' AND EXISTS(
          SELECT 1 FROM events e JOIN json_each(t.wait_json,'$.ids') j ON e.dedupe_key='child:'||j.value WHERE e.task_id=t.id AND e.run_id IS NULL)))
      AND ${budget('t.owner', '?5')}<30`, taskId, key, now, crypto.randomUUID().replaceAll('-', ''), hourISO()),
    stmt(env, `UPDATE events SET run_id=(SELECT id FROM runs WHERE schedule_key=?2)
      WHERE id IN (SELECT id FROM events WHERE task_id=?1 AND run_id IS NULL ORDER BY id LIMIT 128)
      AND EXISTS(SELECT 1 FROM runs WHERE schedule_key=?2)`, taskId, key),
    // A mail wake may deliver only part of an all-wait. Retain undelivered
    // children; an any-wait ends when one of its results reaches this run.
    stmt(env, `UPDATE tasks SET status='active',
      wait_json=CASE WHEN wait_json IS NULL OR
        (json_extract(wait_json,'$.mode')='any' AND EXISTS(
          SELECT 1 FROM events e JOIN json_each(tasks.wait_json,'$.ids') j ON e.dedupe_key='child:'||j.value
          WHERE e.task_id=tasks.id AND e.run_id=(SELECT id FROM runs WHERE schedule_key=?2))) THEN NULL
        ELSE (SELECT json_object('mode',json_extract(tasks.wait_json,'$.mode'),'ids',json_group_array(j.value))
          FROM json_each(tasks.wait_json,'$.ids') j WHERE NOT EXISTS(
            SELECT 1 FROM events e WHERE e.task_id=tasks.id AND e.dedupe_key='child:'||j.value AND e.run_id IS NOT NULL)
          HAVING COUNT(*)>0) END,
      wait_until=NULL,run_count=run_count+1,updated_at=?3
      WHERE id=?1 AND EXISTS(SELECT 1 FROM runs WHERE schedule_key=?2)`, taskId, key, now),
    ...exhausted.statements,
  ]);
  // Exhaustion is terminal, not an eternally unschedulable active task.
  if(result[4].meta.changes) {
    const task=await stmt(env,'SELECT parent_id FROM tasks WHERE id=?1',taskId).first();
    if(task?.parent_id) await schedule(env,task.parent_id,send);
    if(send) await deliverCompletion(env,exhausted.key,send);
  }
  return !!result[1].meta.changes;
}

// Shared terminal transition builder, also embedded in finishRun's phase-one batch.
// completion_key scopes all follow-up statements to rows changed by this batch.
export function completionBatch(env, { taskId, owner = null, status, result = '', resultSql = '?3', key = crypto.randomUUID(), guard = '1=1', cascade = true, notify = true }) {
  const now = nowISO();
  const statements = [stmt(env, `UPDATE tasks SET status=?2,result=substr(${resultSql},1,200000),wait_json=NULL,wait_until=NULL,
      finished_at=?4,updated_at=?4,completion_key=?5,session_id=CASE WHEN ?2='done' THEN session_id ELSE NULL END
    WHERE (?1 IS NULL OR id=?1) AND (?6 IS NULL OR owner=?6) AND status IN ${LIVE} AND (?3 IS NOT NULL) AND (${guard})`, taskId, status, result, now, key, owner)];
  if (cascade) statements.push(stmt(env, `WITH RECURSIVE tree(id) AS (
    SELECT id FROM tasks WHERE completion_key=?1 AND status IN ${TERMINAL}
    UNION ALL SELECT c.id FROM tasks c JOIN tree p ON c.parent_id=p.id)
    UPDATE tasks SET status='cancelled',result='Parent completed',completion_key=?1,session_id=NULL,
      wait_json=NULL,wait_until=NULL,finished_at=?2,updated_at=?2
    WHERE id IN (SELECT id FROM tree) AND status IN ${LIVE}`, key, now));
  statements.push(...completionEffects(env, key, now, notify));
  return { key, statements };
}

function completionEffects(env, key, now, notify) {
  return [
    stmt(env, `UPDATE runs SET status='cancelled',cancel_requested=1,token_hash=NULL,finished_at=?2
      WHERE task_id IN (SELECT id FROM tasks WHERE completion_key=?1) AND status IN ('pending','running')`, key, now),
    stmt(env, `INSERT OR IGNORE INTO events(task_id,kind,payload_json,dedupe_key,created_at)
      SELECT parent_id,'child_result',json_object('task_id',id,'agent',agent,'status',status,
        'text',substr(COALESCE(result,''),1,4000),'outbox',json(COALESCE((SELECT outbox_json FROM runs WHERE task_id=tasks.id ORDER BY id DESC LIMIT 1),'[]'))),
        'child:'||id,?2 FROM tasks WHERE completion_key=?1 AND parent_id IS NOT NULL`, key, now),
    // No attachment bytes in D1. Failed/cancelled root notifications are text only.
    stmt(env, `INSERT OR IGNORE INTO outbound_mails(task_id,dedupe_key,message_id,kind,text,subject,in_reply_to,references_hdr,created_at)
      SELECT id,'terminal:'||?1||':'||id,'<mailbot-task-'||id||'-'||?1||'@'||?3||'>','terminal',
        substr(status||': '||COALESCE(result,''),1,64000),'Re: '||title,rfc_message_id,references_hdr,?2
      FROM tasks WHERE completion_key=?1 AND parent_id IS NULL AND status IN ('failed','cancelled') AND mail_count<15 AND ?4=1`, key, now, domain(env),notify?1:0),
  ];
}

async function deliverCompletion(env,key,send) {
  const {results}=await stmt(env,`SELECT dedupe_key FROM outbound_mails WHERE dedupe_key LIKE ?1`, `terminal:${key}:%`).all();
  for(const mail of results) {
    try {await deliverOutbound(env,mail.dedupe_key,[],send);} catch {/* durable error; cron rotates retries */}
  }
}

export async function completeTask(env, spec, send) {
  const { key, statements } = completionBatch(env, spec);
  await env.DB.batch(statements);
  const { results } = await stmt(env, `SELECT DISTINCT c.parent_id FROM tasks c JOIN tasks p ON p.id=c.parent_id
    WHERE c.completion_key=?1 AND p.status IN ${LIVE}`, key).all();
  for (const t of results) await schedule(env, t.parent_id,send);
  if(send) await deliverCompletion(env,key,send);
}

export async function cancelTask(env, taskId, owner, send, {notify=true}={}) {
  if (!owner) return fail('owner required');
  if (taskId === null) {
    const { results } = await stmt(env, `SELECT id FROM tasks WHERE owner=?1 AND parent_id IS NULL AND status IN ${LIVE}`, owner).all();
    await completeTask(env, {taskId:null,owner,status:'cancelled',result:'Cancelled by owner',notify},send);
    return { ok: true, cancelled: results.map((t) => t.id) };
  }
  const task = await stmt(env, 'SELECT id FROM tasks WHERE id=?1 AND owner=?2', taskId, owner).first();
  if (!task) return fail('not found', 404);
  // Owner check is repeated in SQL, not merely a preflight read.
  await completeTask(env, { taskId, owner, status: 'cancelled', result: 'Cancelled by owner',notify },send);
  return { ok: true, task_id: taskId };
}

export async function claimRun(env, agents) {
  const list = Array.isArray(agents) ? agents.filter((a) => AGENTS.includes(a)) : AGENTS;
  if (!list.length) return null;
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  const marks = list.map((_, i) => `?${i + 3}`).join(',');
  const run = await stmt(env, `UPDATE runs SET status='running',claimed_at=?1,token_hash=?2 WHERE id=(
    SELECT r.id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.status='pending' AND t.status IN ${LIVE}
    AND t.agent IN (${marks}) AND t.expires_at>?1 ORDER BY r.id LIMIT 1) RETURNING *`, nowISO(), await tokenHash(token), ...list).first();
  if (!run) return null;
  const task = await stmt(env, 'SELECT * FROM tasks WHERE id=?1', run.task_id).first();
  // Bound strings in SQL before materializing D1 rows. Preserve full payloads for get_task.
  const { results: bounded } = await stmt(env, `WITH queue AS (
    SELECT id,kind,message_id,payload_json,COALESCE(SUM(length(payload_json)) OVER (
      ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS used
    FROM events WHERE run_id=?1)
    SELECT id,kind,message_id,substr(payload_json,1,max(0,150000-used)) AS payload_json,
      length(payload_json)>max(0,150000-used) AS truncated FROM queue ORDER BY id`, run.id).all();
  const { results: attachments } = await stmt(env, `WITH source_runs(id) AS (
      SELECT ?1 UNION SELECT json_extract(e.payload_json,'$.run_id') FROM events e
      WHERE e.run_id=?1 AND e.kind='run_lost')
    SELECT a.id,a.message_id,a.filename,a.mime_type,a.size,a.content_b64 IS NOT NULL AS stored
    FROM attachments a WHERE a.message_id IN (SELECT e.message_id FROM events e JOIN source_runs s ON s.id=e.run_id
      JOIN runs r ON r.id=s.id WHERE r.task_id=?2) ORDER BY a.message_id,a.id`, run.id,run.task_id).all();
  // Only the run consuming the mail that superseded a wait receives this note.
  // Read our durable finish decision, never a role/source label in mail payloads.
  const { results: skipped_waits } = await stmt(env, `SELECT r.id AS run_id,json_extract(r.outcome_json,'$.skipped_wait.mode') AS mode
    FROM runs r JOIN events e ON e.id=json_extract(r.outcome_json,'$.skipped_wait.mail_event_id')
    WHERE r.task_id=?2 AND e.task_id=r.task_id AND e.run_id=?1 AND e.kind='mail'
      AND json_extract(r.outcome_json,'$.skipped_wait.mode') IN ('user','timer') ORDER BY r.id`,run.id,run.task_id).all();
  return { ...publicRun(run), agent: task.agent, sender: task.owner, project: task.project, subject: task.title,
    parent_id: task.parent_id, deliver: task.deliver, options_json: task.options_json,
    run_token: token, mail_domain: domain(env), resume_session: SID.test(task.session_id || '') ? task.session_id : null,
    events: bounded, attachments, skipped_waits };
}

export async function runForToken(env, token) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
  return stmt(env, `SELECT r.* FROM runs r JOIN tasks t ON t.id=r.task_id
    WHERE r.token_hash=?1 AND r.status='running' AND r.cancel_requested=0 AND t.status IN ${LIVE} AND t.expires_at>?2`, await tokenHash(token),nowISO()).first();
}

const runGuard = `status='running' AND cancel_requested=0 AND token_hash=?2 AND EXISTS(SELECT 1 FROM tasks WHERE id=runs.task_id AND status IN ${LIVE} AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
export async function runTool(env, run, tool, body, send) {
  if (!body || typeof body !== 'object') return fail('invalid arguments');
  // SQL guards below repeat this check to serialize concurrent tool calls.
  if (['spawn','await','reply'].includes(tool) && await stmt(env,
    `SELECT 1 FROM runs WHERE id=?1 AND json_extract(outcome_json,'$.wait.mode')='user'`,run.id).first())
    return fail('ask_user already set; spawn/await/reply are forbidden for this run',409);
  if (tool === 'ask_user' || (tool === 'await' && Object.hasOwn(body,'seconds'))) {
    const asking=tool==='ask_user', seconds=asking?body.timeout_seconds:body.seconds;
    if (Object.keys(body).some(k=>!(asking?['question','timeout_seconds']:['seconds']).includes(k)) ||
      (asking&&!validText(body.question)) || (!asking&&seconds===undefined) ||
      (seconds!==undefined&&(!Number.isSafeInteger(seconds)||seconds<60||seconds>86400)))
      return fail('seconds must be an integer in 60..86400; ask_user requires question');
    const until=seconds===undefined?null:new Date(Date.now()+seconds*1000).toISOString();
    const wait=asking?{mode:'user',run_id:run.id,until}:{mode:'timer',until};
    const changed=await stmt(env,`UPDATE runs SET outcome_json=json_set(
      CASE WHEN ?4 IS NULL THEN outcome_json ELSE json_set(outcome_json,'$.reply_text',?4) END,'$.wait',json(?3))
      WHERE id=?1 AND ${runGuard}
      AND json_extract(outcome_json,'$.wait') IS NULL AND COALESCE(json_array_length(outcome_json,'$.spawned'),0)=0
      AND NOT EXISTS(SELECT 1 FROM tasks c WHERE c.spawn_run_id=runs.id AND c.parent_id=runs.task_id)
      AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=runs.task_id AND (?5 IS NULL OR ?5<=t.expires_at)
        AND t.run_count<t.max_runs
        AND NOT EXISTS(SELECT 1 FROM json_each(t.wait_json,'$.ids') j JOIN tasks c ON c.id=j.value
          WHERE json_extract(t.wait_json,'$.mode') IN ('all','any') AND c.parent_id=t.id AND c.status NOT IN ${TERMINAL})
        ${asking?"AND t.parent_id IS NULL AND t.deliver='email' AND t.question_count<5 AND t.mail_count<14":''})`,
      run.id,run.token_hash,JSON.stringify(wait),asking?body.question:null,until).run();
    return changed.meta.changes?{ok:true}:fail(asking?
      'ask_user: root email task only; spawned children, wait already set or live children still awaited; question/mail/run budget exhausted, timeout exceeds expires_at, or inactive run':
      'await: spawned children, wait already set or live children still awaited; run budget exhausted, timeout exceeds expires_at, or inactive run',409);
  }
  if (tool === 'spawn') return spawnTask(env, run, body);
  if (tool === 'reply') {
    if (!validText(body.text) || Object.keys(body).some((k) => k !== 'text')) return fail('reply accepts text only; use outbox/run-<id>');
    const changed = await stmt(env, `UPDATE runs SET outcome_json=json_set(outcome_json,'$.reply_text',?3)
      WHERE id=?1 AND ${runGuard} AND COALESCE(json_extract(outcome_json,'$.wait.mode'),'')!='user'`, run.id, run.token_hash, body.text).run();
    return changed.meta.changes ? { ok: true } : fail('inactive run', 409);
  }
  if (tool === 'await') {
    const waitIds = body.ids;
    const mode = body.mode || 'all';
    if (!Array.isArray(waitIds) || !waitIds.length || waitIds.length>3 || new Set(waitIds).size!==waitIds.length ||
      waitIds.some((n) => !Number.isSafeInteger(n) || n<1) || !['all','any'].includes(mode) || Object.keys(body).some((k) => !['ids','mode'].includes(k))) return fail('await requires direct, undelivered child ids');
    const changed = await stmt(env, `UPDATE runs SET outcome_json=json_set(outcome_json,'$.wait',json(?3)) WHERE id=?1 AND ${runGuard}
      AND COALESCE(json_extract(outcome_json,'$.wait.mode'),'')!='user'
      AND (SELECT COUNT(*) FROM tasks c JOIN json_each(?3,'$.ids') j ON c.id=j.value WHERE c.parent_id=runs.task_id
        AND NOT EXISTS(SELECT 1 FROM events e WHERE e.dedupe_key='child:'||c.id AND e.run_id IS NOT NULL))=json_array_length(?3,'$.ids')`,
      run.id, run.token_hash, JSON.stringify({mode,ids:waitIds})).run();
    return changed.meta.changes ? { ok: true } : fail('child not direct, already delivered, or inactive run', 409);
  }
  if (tool === 'notify') {
    if (!validText(body.text) || body.text.length>64000 || Object.keys(body).some((k) => k!=='text')) return fail('notify accepts text only');
    const key = crypto.randomUUID(), now=nowISO();
    const result = await env.DB.batch([
      stmt(env, `INSERT INTO outbound_mails(task_id,run_id,dedupe_key,message_id,kind,text,subject,in_reply_to,references_hdr,created_at)
        SELECT t.id,r.id,?3,'<mailbot-notify-'||?3||'@'||?4||'>','notify',?5,'Re: '||t.title,t.rfc_message_id,t.references_hdr,?6
        FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=?1 AND r.token_hash=?2 AND r.status='running' AND r.cancel_requested=0
        AND t.status IN ${LIVE} AND t.expires_at>?6 AND t.parent_id IS NULL AND r.notify_count<3
        AND t.mail_count+CASE WHEN json_extract(r.outcome_json,'$.wait.mode')='user' THEN 1 ELSE 0 END
          +((SELECT COUNT(*)+127 FROM events e WHERE e.task_id=t.id AND e.run_id IS NULL AND e.kind='mail')/128)<14`, run.id,run.token_hash,key,domain(env),body.text,now),
      stmt(env, `UPDATE runs SET notify_count=notify_count+1,outcome_json=json_insert(outcome_json,'$.notifications[#]',?2)
        WHERE id=?1 AND EXISTS(SELECT 1 FROM outbound_mails WHERE dedupe_key=?2)`, run.id,key),
    ]);
    if (!result[0].meta.changes) return fail('root only, inactive run or mail limit',409);
    await deliverOutbound(env, key, [], send);
    return { ok:true };
  }
  return fail('not found',404);
}

export async function spawnTask(env, run, body) {
  if (!AGENTS.includes(body.agent) || !validText(body.prompt) || Object.keys(body).some((k) => !['agent','prompt'].includes(k))) return fail('spawn accepts agent,prompt only');
  const key=crypto.randomUUID(), now=nowISO();
  const result=await env.DB.batch([
    stmt(env, `INSERT INTO tasks(root_id,parent_id,spawn_run_id,depth,agent,owner,project,title,deliver,options_json,rfc_message_id,created_at,updated_at,expires_at)
      SELECT p.root_id,p.id,r.id,p.depth+1,?3,p.owner,p.project,substr(?4,1,300),'parent','{}','<child-'||?5||'@mailbot>',?6,?6,min(p.expires_at,?7)
      FROM runs r JOIN tasks p ON p.id=r.task_id JOIN tasks root ON root.id=p.root_id
      WHERE r.id=?1 AND r.token_hash=?2 AND r.status='running' AND r.cancel_requested=0 AND p.status IN ${LIVE}
      AND COALESCE(json_extract(r.outcome_json,'$.wait.mode'),'')!='user'
      AND root.status IN ${LIVE} AND p.expires_at>?6 AND root.expires_at>?6 AND p.agent!=?3 AND p.depth<2 AND p.child_count<3 AND root.tree_count<8
      AND EXISTS(SELECT 1 FROM allowlist WHERE address=p.owner AND (agent='*' OR agent=?3))
      AND ${budget('p.owner','?8')}<30`,run.id,run.token_hash,body.agent,body.prompt,key,now,expiry(),hourISO()),
    stmt(env, `INSERT INTO events(task_id,kind,payload_json,dedupe_key,created_at)
      SELECT id,'start',json_object('text',?2),'start:'||id,?3 FROM tasks WHERE rfc_message_id=?1`,`<child-${key}@mailbot>`,body.prompt,now),
    stmt(env, `UPDATE runs SET outcome_json=json_insert(outcome_json,'$.spawned[#]',(SELECT id FROM tasks WHERE rfc_message_id=?2))
      WHERE id=?1 AND EXISTS(SELECT 1 FROM tasks WHERE rfc_message_id=?2)`,run.id,`<child-${key}@mailbot>`),
    stmt(env,`INSERT INTO runs(task_id,schedule_key,created_at,boundary)
      SELECT id,?1,?2,?3 FROM tasks WHERE rfc_message_id=?4`,key,now,crypto.randomUUID().replaceAll('-',''),`<child-${key}@mailbot>`),
    stmt(env,`UPDATE events SET run_id=(SELECT id FROM runs WHERE schedule_key=?1)
      WHERE task_id=(SELECT id FROM tasks WHERE rfc_message_id=?2)`,key,`<child-${key}@mailbot>`),
    stmt(env,`UPDATE tasks SET run_count=1 WHERE rfc_message_id=?1`,`<child-${key}@mailbot>`),
  ]);
  if (!result[0].meta.changes) {
    const parent=await stmt(env,'SELECT owner FROM tasks WHERE id=?1',run.task_id).first();
    if (!parent || !await isAllowed(env,parent.owner,body.agent)) return fail('agent not allowed',403);
    const n=await stmt(env,`SELECT ${budget('?1','?2')} n`,parent.owner,hourISO()).first();
    return fail(n.n>=30?'rate limit':'spawn limit or inactive run',n.n>=30?429:409);
  }
  const task=await stmt(env,'SELECT * FROM tasks WHERE rfc_message_id=?1',`<child-${key}@mailbot>`).first();
  await schedule(env,task.id);
  return {task_id:task.id};
}

// Mail sending cannot be transactional with D1. A durable sending reservation
// prevents concurrent retries. Ambiguous sends remain 'sending' for manual review.
export async function deliverOutbound(env, key, files, send) {
  // Timestamp prefix keeps failed text deliveries in least-recent-attempt order
  // using the existing opaque reservation key, without a schema migration.
  const sendKey=nowISO()+':'+crypto.randomUUID();
  const mail=await stmt(env, `UPDATE outbound_mails SET status='sending',send_key=?2,error=NULL
    WHERE dedupe_key=?1 AND status IN ('pending','error') AND (outbox_json='[]' OR ?3=outbox_json) RETURNING *`,
    key,sendKey,JSON.stringify(files.map(({filename,size})=>({filename,size})))).first();
  if (!mail) return;
  const task=await stmt(env,'SELECT agent,owner,project FROM tasks WHERE id=?1',mail.task_id).first();
  try {
    await send(env,{from:`${task.agent}${task.project?'+'+task.project:''}@${domain(env)}`,to:task.owner,subject:mail.subject,
      text:mail.text.slice(0,64000),messageId:mail.message_id,inReplyTo:mail.in_reply_to,references:mail.references_hdr,attachments:files});
    await stmt(env,`UPDATE outbound_mails SET status='sent',sent_at=?3 WHERE id=?1 AND send_key=?2`,mail.id,sendKey,nowISO()).run();
  } catch (e) {
    await stmt(env,`UPDATE outbound_mails SET status='error',error=?3 WHERE id=?1 AND send_key=?2`,mail.id,sendKey,String(e.message||e).slice(0,1000)).run();
    throw e;
  }
}

export async function finishRun(env, id, body, send) {
  const old=await stmt(env,'SELECT * FROM runs WHERE id=?1',id).first();
  if (!old) return fail('not found',404);
  // Cancel/lost result cannot commit, attach, or restore a session.
  if (!old.result_hash && old.status!=='running') return {ok:true,ignored:true};
  let files;
  try {files=validateAttachments(body.attachments||[]);} catch(e){return fail(e.message);}
  const metadata=JSON.stringify(files.map(({filename,size})=>({filename,size})));
  const output=String(body.output||'').slice(0,200000);
  const note=String(body.finalize_note||'').slice(0,50000);
  const hash=await tokenHash(JSON.stringify([!!body.ok,!!body.cancelled,output,body.session_id||null,metadata,note]));
  if (old.result_hash && (hash!==old.result_hash || metadata!==old.outbox_json)) return fail('result or attachments mismatch',409);
  const key=crypto.randomUUID(),now=nowISO();
  if (!old.result_hash) {
    const sid=body.ok && !body.cancelled && SID.test(body.session_id||'')?body.session_id:null;
    // All finish decisions use the current SQL outcome and event queue, not a JS snapshot.
    const doneGuard=`EXISTS(SELECT 1 FROM runs WHERE id=${Number(id)} AND finish_key='${key}')`;
    const terminal=completionBatch(env,{taskId:old.task_id,status:body.cancelled?'cancelled':body.ok?'done':'failed',result:output,
      resultSql:body.ok&&!body.cancelled?`(SELECT COALESCE(json_extract(outcome_json,'$.reply_text')||COALESCE(json_extract(outcome_json,'$.finalize_note'),''),output) FROM runs WHERE id=${Number(id)})`:'?3',
      key,guard:`${doneGuard} AND ((NOT EXISTS(SELECT 1 FROM events WHERE task_id=tasks.id AND run_id IS NULL)
        OR (parent_id IS NULL AND NOT EXISTS(SELECT 1 FROM events WHERE task_id=tasks.id AND run_id IS NULL AND kind!='mail')))
        AND wait_json IS NULL AND NOT EXISTS(SELECT 1 FROM runs WHERE id=${Number(id)} AND json_extract(outcome_json,'$.skipped_wait') IS NOT NULL)
        OR ${body.ok&&!body.cancelled?'0':'1'}=1)`});
    await env.DB.batch([
      stmt(env,`UPDATE runs SET status=CASE WHEN ?2=1 THEN 'cancelled' WHEN ?3=1 THEN 'done' ELSE 'failed' END,
        output=?4,session_id=?5,outbox_json=?6,result_hash=?7,finish_key=?8,token_hash=NULL,finished_at=?9,outcome_json=json_set(outcome_json,'$.finalize_note',?10)
        WHERE id=?1 AND status='running' AND cancel_requested=0 AND EXISTS(SELECT 1 FROM tasks WHERE id=runs.task_id AND status IN ${LIVE} AND expires_at>?9)`,
        id,body.cancelled?1:0,body.ok?1:0,output,sid,metadata,hash,key,now,note),
      // Mail received during this run supersedes its question/timer. Persist the
      // decision with finish_key so retries cannot reserve/send that question,
      // even after schedule has consumed the mail. Keep the original wait for audit.
      stmt(env,`UPDATE runs SET outcome_json=json_set(outcome_json,'$.skipped_wait',json_object(
          'mode',json_extract(outcome_json,'$.wait.mode'),
          'mail_event_id',(SELECT MIN(id) FROM events WHERE task_id=runs.task_id AND run_id IS NULL AND kind='mail')))
        WHERE id=?1 AND finish_key=?2 AND status='done' AND json_extract(outcome_json,'$.wait.mode') IN ('user','timer')
          AND EXISTS(SELECT 1 FROM events WHERE task_id=runs.task_id AND run_id IS NULL AND kind='mail')`,id,key),
      stmt(env,`UPDATE tasks SET session_id=?3,lost_count=0,updated_at=?4,
        wait_json=CASE WHEN ?5=0 THEN NULL ELSE COALESCE((SELECT json_extract(outcome_json,'$.wait') FROM runs WHERE id=?2
          AND json_extract(outcome_json,'$.skipped_wait') IS NULL),wait_json,
          (SELECT json_object('mode','all','ids',json_group_array(id)) FROM tasks c WHERE c.spawn_run_id=?2 AND c.parent_id=tasks.id HAVING COUNT(*)>0)) END
        WHERE id=?1 AND EXISTS(SELECT 1 FROM runs WHERE id=?2 AND finish_key=?6)`,old.task_id,id,sid,now,body.ok&&!body.cancelled?1:0,key),
      stmt(env,`UPDATE tasks SET status=CASE WHEN wait_json IS NULL THEN 'active' ELSE 'waiting' END
        ,wait_until=json_extract(wait_json,'$.until')
        WHERE id=?1 AND EXISTS(SELECT 1 FROM runs WHERE id=?2 AND finish_key=?3)`,old.task_id,id,key),
      stmt(env,`INSERT OR IGNORE INTO outbound_mails(task_id,run_id,dedupe_key,message_id,kind,text,subject,in_reply_to,references_hdr,created_at)
        SELECT t.id,r.id,'question:run:'||r.id,'<mailbot-question-'||r.id||'@'||?3||'>','question',
          substr(json_extract(r.outcome_json,'$.reply_text')||COALESCE(json_extract(r.outcome_json,'$.finalize_note'),''),1,63000)||char(10)||'-- task #'||t.id||' run #'||r.id,
          'Re: '||t.title,t.rfc_message_id,t.references_hdr,?4
        FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=?1 AND r.finish_key=?2 AND r.status='done'
          AND t.deliver='email' AND t.parent_id IS NULL AND t.status='waiting'
          AND json_extract(r.outcome_json,'$.wait.mode')='user' AND json_extract(t.wait_json,'$.mode')='user'
          AND t.question_count<5 AND t.mail_count<15`,id,key,domain(env),now),
      ...terminal.statements,
      stmt(env,`INSERT OR IGNORE INTO outbound_mails(task_id,run_id,dedupe_key,message_id,kind,text,subject,in_reply_to,references_hdr,outbox_json,created_at)
        SELECT t.id,r.id,'reply:run:'||r.id,'<mailbot-run-'||r.id||'@'||?3||'>','reply',
          substr(COALESCE(json_extract(r.outcome_json,'$.reply_text')||COALESCE(json_extract(r.outcome_json,'$.finalize_note'),''),r.output),1,63000)||char(10)||'-- task #'||t.id||' run #'||r.id,
          'Re: '||t.title,t.rfc_message_id,t.references_hdr,r.outbox_json,?4
        FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=?1 AND r.finish_key=?2 AND r.status='done'
          AND t.parent_id IS NULL AND t.status='done' AND t.mail_count<15`,id,key,domain(env),now),
      // Complete and reserve this run's reply first, then accept queued owner
      // mail as a new conversation turn with a fresh run budget and same session.
      stmt(env,`UPDATE tasks SET status='active',max_runs=run_count+8,expires_at=?4,
        finished_at=NULL,completion_key=NULL,updated_at=?3
        WHERE id=?1 AND status='done' AND parent_id IS NULL AND mail_count<15
        AND EXISTS(SELECT 1 FROM runs WHERE id=?2 AND finish_key=?5)
        AND EXISTS(SELECT 1 FROM events WHERE task_id=?1 AND run_id IS NULL AND kind='mail')`,old.task_id,id,now,expiry(),key),
    ]);
  }
  const saved=await stmt(env,'SELECT result_hash,outbox_json,finish_key FROM runs WHERE id=?1',id).first();
  if (!saved.result_hash) return {ok:true,ignored:true};
  if(saved.result_hash!==hash) return fail('result mismatch',409);
  await schedule(env,old.task_id,send);
  const task=await stmt(env,'SELECT parent_id FROM tasks WHERE id=?1',old.task_id).first();
  if(task?.parent_id) await schedule(env,task.parent_id,send);
  // Recover schedules for cancelled descendants as well, without reading full output.
  const {results:parents}=await stmt(env,`SELECT DISTINCT c.parent_id FROM tasks c JOIN tasks p ON p.id=c.parent_id
    WHERE c.completion_key=?1 AND p.status IN ${LIVE}`,saved.finish_key).all();
  for(const p of parents) await schedule(env,p.parent_id,send);
  try {await deliverOutbound(env,`reply:run:${id}`,files,send);} catch(e) {
    // Attachment bytes live only in the executor request; keep its retry path.
    if(files.length) throw e;
  }
  try {await deliverOutbound(env,`question:run:${id}`,[],send);} catch {/* durable text error; cron retries */}
  await deliverCompletion(env,saved.finish_key,send);
  return {ok:true,task_status:(await stmt(env,'SELECT status FROM tasks WHERE id=?1',old.task_id).first())?.status};
}

export async function submitTask(env, {agent,prompt,project=null,owner,title,mail=null,msgId=null,options={}}) {
  owner=typeof owner==='string'?owner.trim().toLowerCase():'';
  if(!AGENTS.includes(agent)||!validText(prompt)||!/^\S+@[^\s<>]+\.[^\s<>]+$/.test(owner)||
    (project!==null&&!/^[a-z0-9-]{1,32}$/.test(project))) return fail('invalid task');
  if(!await isAllowed(env,owner,agent)) return fail('owner not allowed',403);
  const key=crypto.randomUUID(),now=nowISO();
  const rfc=ids(mail?.messageId)[0]||`<submit-${key}@${domain(env)}>`;
  // Root/event and first run are reserved together. The first run consumes the
  // hourly budget before another root/spawn can be accepted.
  const result=await env.DB.batch([
    stmt(env,`INSERT INTO tasks(creation_key,agent,owner,project,title,deliver,options_json,rfc_message_id,references_hdr,created_at,updated_at,expires_at)
      SELECT ?1,?2,?3,?4,?5,'email',?6,?7,?8,?9,?9,?10 WHERE ${budget('?3','?11')}<30
      AND (SELECT COUNT(*) FROM tasks WHERE owner=?3 AND parent_id IS NULL AND status IN ${LIVE})<30`,
      key,agent,owner,project,String(title||prompt.split('\n')[0]).slice(0,300),JSON.stringify({...options,new:false}),rfc,ids(mail?.references).join(' '),now,expiry(),hourISO()),
    stmt(env,`INSERT INTO events(task_id,kind,message_id,rfc_message_id,payload_json,dedupe_key,created_at)
      SELECT id,'start',?2,?3,?4,'start:'||id,?5 FROM tasks WHERE creation_key=?1`,key,msgId,rfc,JSON.stringify({subject:title||'',text:prompt}),now),
    stmt(env,`INSERT INTO runs(task_id,schedule_key,created_at,boundary)
      SELECT id,?1,?2,?3 FROM tasks WHERE creation_key=?1`,key,now,crypto.randomUUID().replaceAll('-','')),
    stmt(env,`UPDATE events SET run_id=(SELECT id FROM runs WHERE schedule_key=?1) WHERE task_id=(SELECT id FROM tasks WHERE creation_key=?1)`,key),
    stmt(env,`UPDATE tasks SET run_count=1 WHERE creation_key=?1`,key),
  ]);
  if(!result[0].meta.changes) return fail('rate limit',429);
  return {task:await stmt(env,'SELECT * FROM tasks WHERE creation_key=?1',key).first()};
}

export async function mapMail(env,{sender,agent,mail}) {
  const candidates=[...new Set([...ids(mail.inReplyTo),...ids(mail.references).reverse()])].slice(0,30);
  for(const candidate of candidates) {
    const task=await stmt(env,`SELECT t.* FROM tasks t WHERE owner=?1 AND agent=?2 AND parent_id IS NULL AND
      (rfc_message_id=?3 OR EXISTS(SELECT 1 FROM outbound_mails m WHERE m.task_id=t.id AND m.message_id=?3)
      OR EXISTS(SELECT 1 FROM events e WHERE e.task_id=t.id AND e.rfc_message_id=?3)) ORDER BY t.id DESC LIMIT 1`,sender,agent,candidate).first();
    if(task) return task;
  }
  return null;
}

export async function receiveTaskMail(env,{msgId,agent,tag=null,sender,mail},send) {
  // Authentication/agent whitelist are mandatory at the SMTP boundary too.
  if(!await isAllowed(env,sender,agent)) return fail('owner not allowed',403);
  const automated=(mail.headerLines||[]).some((h)=>{
    const key=String(h.key).toLowerCase(), value=String(h.line).replace(/^[^:]*:/,'').trim();
    return key==='auto-submitted'&&!/^no$/i.test(value) || key==='x-auto-response-suppress' ||
      key==='precedence'&&/^(bulk|auto_reply|list)$/i.test(value);
  });
  if(automated) return {status:'auto_suppressed'};
  const parsed=parseSubject(mail.subject),now=nowISO();
  if(parsed.error||parsed.action) {
    // Cancellation is effective even when the command response budget is full.
    let cancelled;
    if(!parsed.error&&parsed.action==='cancel') cancelled=await cancelTask(env,parsed.cancelId,sender,send,{notify:false});
    const reserved=await stmt(env,`INSERT INTO command_receipts(sender,created_at)
      SELECT ?1,?2 WHERE ${budget('?1','?3')}<30 RETURNING id`,sender,now,hourISO()).first();
    if(!reserved) return {status:'command_suppressed'};
    const {results:tasks}=await stmt(env,`SELECT id,agent,status,title,wait_json,wait_until FROM tasks WHERE owner=?1 ORDER BY id DESC LIMIT 20`,sender).all();
    const text=parsed.error?`${parsed.error}\n${COMMAND_HELP}`:parsed.action==='cancel'?JSON.stringify(cancelled):
      tasks.map((t)=>`#${t.id} ${t.agent} ${t.status}${t.wait_json?' '+t.wait_json:''}${t.wait_until?' until '+t.wait_until:''}: ${t.title}`).join('\n')||'(không có task)';
    // Command receipts reserve before sending; command mail does not belong to a task.
    await send(env,{from:`${agent}${tag?'+'+tag:''}@${domain(env)}`,to:sender,subject:`Re: ${parsed.subject||`[${parsed.action||'help'}]`}`,
      text:text.slice(0,64000),messageId:`<mailbot-command-${reserved.id}@${domain(env)}>`,inReplyTo:mail.messageId,references:mail.references});
    return {status:'command'};
  }
  let task=parsed.options.new?null:await mapMail(env,{sender,agent,mail});
  const project=tag||task?.project||null;
  if(task&&(tag!==null&&tag!==task.project||['failed','cancelled'].includes(task.status)||
    (task.status!=='done'&&task.expires_at<=now)||task.mail_count>=14&&!(task.status==='waiting'&&['user','timer'].includes(JSON.parse(task.wait_json||'{}').mode)&&task.mail_count<15))) task=null;
  const prompt=(extractPrompt(mail.text)||parsed.subject||'(empty mail)').slice(0,150000);
  const fresh=async()=>{
    const result=await submitTask(env,{agent,prompt,project,owner:sender,title:parsed.subject,mail,msgId,options:parsed.options});
    return result.error?{...result,status:'rate_limited'}:{id:result.task.id,status:'active'};
  };
  if(!task) return fresh();
  // A reply to done grants eight new runs and 24h while retaining task/session.
  // UPDATE is transactional with event insertion, so finish and incoming mail serialize.
  const received=await env.DB.batch([
    stmt(env,`UPDATE tasks SET max_runs=CASE WHEN status='done' THEN run_count+8 ELSE max_runs END,
      expires_at=CASE WHEN status='done' THEN ?3 ELSE expires_at END,finished_at=NULL,completion_key=NULL,
      status='active',options_json=json_patch(options_json,?4),updated_at=?2
      ,wait_until=NULL,wait_json=CASE WHEN json_extract(wait_json,'$.mode') IN ('user','timer') THEN NULL ELSE wait_json END
      WHERE id=?1 AND status IN ('active','waiting','done')
        AND NOT EXISTS(SELECT 1 FROM events WHERE dedupe_key=?5)
        AND mail_count+(SELECT COUNT(*) FROM events e WHERE e.task_id=tasks.id AND e.run_id IS NULL)/128<
          CASE WHEN status='waiting' AND json_extract(wait_json,'$.mode') IN ('user','timer') THEN 15 ELSE 14 END
        AND (status='done' OR expires_at>?2)`,task.id,now,expiry(),JSON.stringify(parsed.options),`mail:${task.id}:${msgId}`),
    stmt(env,`INSERT OR IGNORE INTO events(task_id,kind,message_id,rfc_message_id,payload_json,dedupe_key,created_at)
      SELECT id,'mail',?2,?3,?4,?5,?6 FROM tasks WHERE id=?1 AND status IN ${LIVE}
        AND changes()=1
        AND mail_count+(SELECT COUNT(*) FROM events e WHERE e.task_id=tasks.id AND e.run_id IS NULL)/128<15
        AND expires_at>?6`,
      task.id,msgId,ids(mail.messageId)[0]||'',JSON.stringify({subject:parsed.subject,text:prompt}),`mail:${task.id}:${msgId}`,now),
  ]);
  if(!received[1].meta.changes && !await stmt(env,'SELECT 1 FROM events WHERE dedupe_key=?1',`mail:${task.id}:${msgId}`).first()) return fresh();
  await schedule(env,task.id,send);
  return {id:task.id,status:'active'};
}

export async function getTask(env,id,owner) {
  const task=await stmt(env,'SELECT * FROM tasks WHERE id=?1 AND owner=?2',id,owner).first();
  if(!task) return fail('not found',404);
  const {results:runs}=await stmt(env,'SELECT id,task_id,status,created_at,claimed_at,finished_at,cancel_requested,output,outcome_json,outbox_json,session_id FROM runs WHERE task_id=?1 ORDER BY id',id).all();
  const {results:events}=await stmt(env,'SELECT * FROM events WHERE task_id=?1 ORDER BY id',id).all();
  const {results:outbound_mails}=await stmt(env,'SELECT * FROM outbound_mails WHERE task_id=?1 ORDER BY id',id).all();
  return {task,runs,events,outbound_mails};
}

export async function answerTask(env,id,owner,body,send) {
  if(!body||!validText(body.text)||Object.keys(body).some(k=>k!=='text')) return fail('answer_task accepts text only');
  const task=await stmt(env,`SELECT * FROM tasks WHERE id=?1 AND owner=?2 AND parent_id IS NULL AND deliver='email'
    AND status='waiting' AND json_extract(wait_json,'$.mode')='user' AND expires_at>?3`,id,owner,nowISO()).first();
  if(!task) return fail('root task of owner must be waiting for user',409);
  const wait=JSON.parse(task.wait_json),key=`answer:${id}:${wait.run_id}`,now=nowISO();
  const result=await env.DB.batch([
    stmt(env,`INSERT OR IGNORE INTO events(task_id,kind,payload_json,dedupe_key,created_at)
      SELECT id,'mail',?3,?4,?5 FROM tasks WHERE id=?1 AND owner=?2 AND parent_id IS NULL AND deliver='email'
        AND status='waiting' AND json_extract(wait_json,'$.mode')='user' AND json_extract(wait_json,'$.run_id')=?6
        AND expires_at>?5 AND mail_count<15 AND ${budget('?2','?7')}<30`,
      id,owner,JSON.stringify({text:body.text,source:'orchestrator'}),key,now,wait.run_id,hourISO()),
    // changes() refers to the immediately preceding event INSERT inside this
    // transaction: duplicate/concurrent answers never spend another receipt.
    stmt(env,`INSERT INTO command_receipts(sender,created_at) SELECT ?1,?2 WHERE changes()=1`,owner,now),
    stmt(env,`UPDATE tasks SET status='active',wait_json=NULL,wait_until=NULL,updated_at=?3
      WHERE id=?1 AND owner=?2 AND status='waiting' AND json_extract(wait_json,'$.run_id')=?4
        AND EXISTS(SELECT 1 FROM events WHERE dedupe_key=?5)`,id,owner,now,wait.run_id,key),
  ]);
  if(!result[0].meta.changes) {
    const duplicate=await stmt(env,'SELECT payload_json FROM events WHERE task_id=?1 AND dedupe_key=?2',id,key).first();
    if(!duplicate || JSON.parse(duplicate.payload_json).text!==body.text) {
      const used=await stmt(env,`SELECT ${budget('?1','?2')} n`,owner,hourISO()).first();
      return fail(used.n>=30?'owner rate limit':'task no longer waiting for user',used.n>=30?429:409);
    }
  }
  await schedule(env,id,send);
  return {ok:true,task_id:id};
}

// Hard cap on work per tick. D1 state is committed before attempting any mail.
export async function cronTick(env,send) {
  const now=nowISO(),stale=new Date(Date.now()-30*60000).toISOString();
  const {results:lost}=await stmt(env,`SELECT id,task_id FROM runs WHERE status='running' AND claimed_at<?1 ORDER BY id LIMIT 1`,stale).all();
  for(const run of lost) {
    const key=crypto.randomUUID();
    const terminal=completionBatch(env,{taskId:run.task_id,status:'failed',result:'Repeated run_lost or exhausted budget',key,
      guard:`EXISTS(SELECT 1 FROM runs WHERE id=${Number(run.id)} AND finish_key='${key}') AND (lost_count>=2 OR run_count>=max_runs)`});
    const lostResult=await env.DB.batch([
      stmt(env,`UPDATE runs SET status='failed',token_hash=NULL,cancel_requested=1,finished_at=?2,finish_key=?3,output='run_lost'
        WHERE id=?1 AND status='running' AND claimed_at<?4`,run.id,now,key,stale),
      stmt(env,`UPDATE tasks SET status='active',lost_count=lost_count+1,session_id=NULL,updated_at=?3
        WHERE id=?1 AND status IN ${LIVE} AND EXISTS(SELECT 1 FROM runs WHERE id=?2 AND finish_key=?4)`,run.task_id,run.id,now,key),
      stmt(env,`INSERT OR IGNORE INTO events(task_id,kind,payload_json,dedupe_key,created_at)
        SELECT task_id,'run_lost',json_object('run_id',id,'outcome',json(outcome_json),
          'context',(SELECT json_group_array(json_object('kind',kind,'payload',payload)) FROM
            (SELECT kind,substr(payload_json,1,12000) AS payload FROM events WHERE run_id=?1 ORDER BY id LIMIT 3))),
          'lost:'||id,?3 FROM runs WHERE id=?1 AND finish_key=?2`,run.id,key,now),
      ...terminal.statements,
    ]);
    if(!lostResult[0].meta.changes) continue;
    await deliverCompletion(env,key,send);
    await schedule(env,run.task_id,send);
    const parent=await stmt(env,'SELECT parent_id FROM tasks WHERE id=?1',run.task_id).first();
    if(parent?.parent_id) await schedule(env,parent.parent_id,send);
  }
  const {results:expired}=await stmt(env,`SELECT id FROM tasks WHERE status IN ${LIVE} AND expires_at<=?1 ORDER BY expires_at LIMIT 1`,now).all();
  for(const t of expired) await completeTask(env,{taskId:t.id,status:'failed',result:'Task TTL expired',guard:`expires_at<='${now}'`},send);
  const {results:timers}=await stmt(env,`SELECT id,wait_until FROM tasks INDEXED BY idx_tasks_timer
    WHERE status='waiting' AND wait_until<=?1 AND expires_at>?1 AND json_extract(wait_json,'$.mode') IN ('user','timer')
      AND NOT EXISTS(SELECT 1 FROM events e WHERE e.dedupe_key='timer:'||tasks.id||':'||tasks.wait_until)
    ORDER BY wait_until,id LIMIT 2`,now).all();
  for(const t of timers) {
    await stmt(env,`INSERT OR IGNORE INTO events(task_id,kind,payload_json,dedupe_key,created_at)
      SELECT id,'timer',json_object('wait_until',wait_until,'source','system','text',
        CASE WHEN json_extract(wait_json,'$.mode')='user' THEN 'người dùng chưa trả lời' ELSE 'đã đến giờ hẹn' END),
        'timer:'||id||':'||wait_until,?3 FROM tasks WHERE id=?1 AND status='waiting' AND wait_until=?2
        AND wait_until<=?3 AND expires_at>?3 AND json_extract(wait_json,'$.mode') IN ('user','timer')`,t.id,t.wait_until,now).run();
    await schedule(env,t.id,send);
  }
  const {results:queued}=await stmt(env,`SELECT t.id FROM tasks t WHERE t.status IN ${LIVE} AND t.expires_at>?2
    AND EXISTS(SELECT 1 FROM events e WHERE e.task_id=t.id AND e.run_id IS NULL)
    AND NOT EXISTS(SELECT 1 FROM runs WHERE task_id=t.id AND status IN ('pending','running'))
    AND (t.run_count>=t.max_runs OR ${budget('t.owner','?1')}<30)
    AND (t.status='active' OR EXISTS(SELECT 1 FROM events e WHERE e.task_id=t.id AND e.run_id IS NULL AND ${wakeEvent('t','e')})
      OR (json_extract(t.wait_json,'$.mode')='all' AND NOT EXISTS(
        SELECT 1 FROM json_each(t.wait_json,'$.ids') j JOIN tasks c ON c.id=j.value WHERE c.status NOT IN ${TERMINAL}))
      OR (json_extract(t.wait_json,'$.mode')='any' AND EXISTS(
        SELECT 1 FROM events e JOIN json_each(t.wait_json,'$.ids') j ON e.dedupe_key='child:'||j.value WHERE e.task_id=t.id AND e.run_id IS NULL)))
    ORDER BY t.updated_at,t.id LIMIT 2`,hourISO(),now).all();
  for(const t of queued) await schedule(env,t.id,send);
  const {results:mails}=await stmt(env,`SELECT dedupe_key FROM outbound_mails WHERE status IN ('pending','error') AND outbox_json='[]'
    ORDER BY status='error',COALESCE(send_key,''),id LIMIT 1`).all();
  for(const m of mails) {try{await deliverOutbound(env,m.dedupe_key,[],send);}catch{/* durable error, retry next tick */}}
  // Bounded tree retention. Live descendants or unsent/ambiguous mail prevent deletion.
  const {results:old}=await stmt(env,`SELECT id FROM tasks t WHERE parent_id IS NULL AND status IN ${TERMINAL}
    AND finished_at<strftime('%Y-%m-%dT%H:%M:%fZ',?1,'-7 days')
    AND id<(SELECT id FROM tasks WHERE parent_id IS NULL ORDER BY id DESC LIMIT 1 OFFSET 999)
    AND NOT EXISTS(SELECT 1 FROM tasks c WHERE c.root_id=t.id AND c.status IN ${LIVE})
    AND NOT EXISTS(SELECT 1 FROM outbound_mails m JOIN tasks c ON c.id=m.task_id WHERE c.root_id=t.id AND m.status!='sent')
    ORDER BY id LIMIT 1`,now).all();
  for(const t of old) await env.DB.batch([
    stmt(env,'DELETE FROM outbound_mails WHERE task_id IN (SELECT id FROM tasks WHERE root_id=?1)',t.id),
    stmt(env,'DELETE FROM events WHERE task_id IN (SELECT id FROM tasks WHERE root_id=?1)',t.id),
    stmt(env,'DELETE FROM runs WHERE task_id IN (SELECT id FROM tasks WHERE root_id=?1)',t.id),
    stmt(env,'DELETE FROM tasks WHERE root_id=?1',t.id),
  ]);
  await stmt(env,'DELETE FROM command_receipts WHERE created_at<?1',hourISO()).run();
  return {lost:lost.length,expired:expired.length,timers:timers.length,queued:queued.length};
}
