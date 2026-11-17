import { mkdirSync, lstatSync, realpathSync, existsSync, writeFileSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function ordinaryDirectory(path) {
  const st=lstatSync(path);
  if(!st.isDirectory()||st.isSymbolicLink()||!same(realpathSync.native(path),path)) throw new Error('Task directory redirected');
}

export function prepareTaskDirectory(workdir,agent,id) {
  if(!['claude','codex','agy'].includes(agent)||!Number.isSafeInteger(id)||id<1) throw new Error('Invalid task directory identity');
  const root=resolve(workdir);mkdirSync(root,{recursive:true});ordinaryDirectory(root);
  const parent=join(root,agent);mkdirSync(parent,{recursive:true});ordinaryDirectory(parent);
  const path=join(parent,`task-${id}`);mkdirSync(path,{recursive:true});ordinaryDirectory(path);
  return path;
}

// Metadata is outside every CLI cwd. Only untagged task directories use this GC;
// project worktrees retain the existing clean+merged prune policy.
export function recordTaskUse(workdir,run) {
  if(run.project) return;
  const root=resolve(workdir);ordinaryDirectory(root);
  const state=join(root,'task-state');mkdirSync(state,{recursive:true});ordinaryDirectory(state);
  const path=join(state,`${run.agent}-task-${run.task_id}.json`);
  if(existsSync(path)) {
    const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1) throw new Error('Unsafe task state');
  }
  writeFileSync(path,JSON.stringify({agent:run.agent,id:run.task_id,last_used:Date.now()}),{flag:'w'});
}

export async function pruneTaskDirectories(workdir,lookup,{now=Date.now(),days=7,limit=1}={}) {
  const root=resolve(workdir),state=join(root,'task-state');
  if(!existsSync(state)) return [];
  ordinaryDirectory(root);ordinaryDirectory(state);
  const removed=[];
  for(const name of readdirSync(state).filter(n=>/^(claude|codex|agy)-task-[1-9]\d*\.json$/.test(n))) {
    if(removed.length>=limit) break;
    const marker=join(state,name),st=lstatSync(marker);
    if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1) continue;
    const data=JSON.parse(readFileSync(marker,'utf8'));
    if(name!==`${data.agent}-task-${data.id}.json`||!Number.isSafeInteger(data.id)||data.id<1||
      !Number.isFinite(data.last_used)||now-data.last_used<days*86400000) continue;
    const task=await lookup(data.id);
    if(!task||task.project||!['done','failed','cancelled'].includes(task.status)||
      !task.finished_at||now-Date.parse(task.finished_at)<days*86400000) continue;
    const parent=join(root,data.agent),path=join(parent,`task-${data.id}`);
    ordinaryDirectory(root);ordinaryDirectory(state);ordinaryDirectory(parent);
    if(existsSync(path)) {
      ordinaryDirectory(path);
      // Refuse links at every level before recursive removal.
      const scan=[path];
      while(scan.length) for(const entry of readdirSync(scan.pop(),{withFileTypes:true})) {
        const p=join(entry.parentPath,entry.name),leaf=lstatSync(p);
        if(leaf.isSymbolicLink()) throw new Error('Task retention refuses links');
        if(leaf.isDirectory()) {ordinaryDirectory(p);scan.push(p);}
      }
      ordinaryDirectory(parent);ordinaryDirectory(path);
      rmSync(path,{recursive:true});
    }
    unlinkSync(marker);removed.push(data.id);
  }
  return removed;
}
