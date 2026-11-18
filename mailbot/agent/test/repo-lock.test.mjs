import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockRepository, withRepositoryLock } from '../worktrees.mjs';

const turn=()=>new Promise(setImmediate);
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'mailbot-repo-lock-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const repo=join(root,'repo'),other=join(root,'other');mkdirSync(repo);mkdirSync(other);
  return {root,repo,other};
}

test('P3.5 canonical repo FIFO waits before file lock; unrelated repo proceeds and failure does not poison queue', async t=>{
  const {root,repo,other}=fixture(t),gate=Promise.withResolvers(),events=[];
  const alias=process.platform==='win32'?repo.toUpperCase():join(repo,'.');
  const first=withRepositoryLock(root,repo,async()=>{events.push(1);await gate.promise;throw new Error('first failed');});
  const rejected=assert.rejects(first,/first failed/);
  // A single file-lock attempt would fail immediately without the local queue.
  const second=withRepositoryLock(root,alias,async()=>{events.push(2);return 'second';},{attempts:1});
  const third=withRepositoryLock(root,repo,async()=>{events.push(3);},{attempts:1});
  const independent=withRepositoryLock(root,other,async()=>{events.push('other');});
  await independent;await turn();assert.deepEqual(events,[1,'other']);
  gate.resolve();await rejected;assert.equal(await second,'second');await third;
  assert.deepEqual(events,[1,'other',2,3]);
  assert.equal(await withRepositoryLock(root,repo,async()=>42),42);
});

test('P3.5 external file lock wait yields so a timer can release the lock', async t=>{
  const {root,repo}=fixture(t),release=await lockRepository(root,repo);
  const timer=setTimeout(release,10);
  t.after(()=>clearTimeout(timer));
  const unlock=await lockRepository(root,repo,{attempts:10});unlock();
});
