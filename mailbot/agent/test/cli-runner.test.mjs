import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createCliRunner } from '../cli-runner.mjs';
import { createRunPool } from '../run-pool.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const spec = { cmd: 'fake-cli', args: [], stdin: 'untrusted mail' };
function fixture(options = {}) {
  const pending = new Map(), children = [], killed = []; let id = 0;
  const clock = {
    setTimer(fn, ms) { pending.set(++id, { fn, ms }); return id; },
    clearTimer(id) { pending.delete(id); },
    async fire(id) { const timer = pending.get(id); assert.ok(timer); pending.delete(id); await timer.fn(); await turn(); },
  };
  const run = createCliRunner({ ...clock, timeoutMs: 1000, cancelMs: 100,
    getState: async runId => ({ status: 'running', cancel_requested: runId === 1 }),
    spawnProcess: () => {
      const child = new EventEmitter(); child.pid = children.length + 1;
      for (const pipe of ['stdout', 'stderr', 'stdin']) child[pipe] = new PassThrough();
      children.push(child); return child;
    },
    killProcess: (pid, cb) => { killed.push(pid); children[pid - 1].emit('close', -1); cb(); },
    ...options,
  });
  return { run, clock, pending, children, killed };
}

test('cancel one run and timeout its replacement leave the other CLI running and refill slots', async t => {
  const f = fixture(), results = new Map(); let claimed = 0;
  const pool = createRunPool({ agents: ['claude'], maxParallel: 2, maxPerAgent: 2,
    claim: async () => claimed < 3 ? { id: ++claimed, agent: 'claude' } : null,
    execute: async job => { results.set(job.id, await f.run(spec, 'fake-cwd', job)); },
  });
  t.after(() => pool.close());
  await pool.wake(); await turn(); assert.equal(f.children.length, 2);
  await f.clock.fire(2); // first run's cancel poll
  assert.deepEqual(f.killed, [1]); assert.equal(results.get(1).cancelled, true);
  assert.equal(results.has(2), false); assert.equal(f.children.length, 3);
  assert.deepEqual(pool.snapshot().running, { claude: 2 });
  await f.clock.fire(5); // replacement's timeout; peer's timers unchanged
  assert.deepEqual(f.killed, [1, 3]); assert.equal(results.get(3).timedOut, true);
  assert.equal(results.has(2), false); assert.equal(pool.snapshot().running.claude, 1);
  f.children[1].stdout.write('peer output'); f.children[1].emit('close', 0); await turn();
  assert.equal(results.get(2).out, 'peer output'); assert.equal(results.get(2).cancelled, false);
  assert.equal(results.get(2).timedOut, false); assert.equal(pool.snapshot().occupied, 0);
  assert.equal(f.pending.size, 0);
});

test('CLI error and synchronous spawn failure reject/finish only that invocation; no timers leak', async () => {
  const f = fixture();
  const first = f.run(spec, 'cwd', { id: 1 }), second = f.run(spec, 'cwd', { id: 2 });
  f.children[0].emit('error', new Error('CLI crashed'));
  assert.match((await first).err, /CLI crashed/); assert.equal(f.pending.size, 2);
  f.children[1].emit('close', 0); assert.equal((await second).code, 0); assert.equal(f.pending.size, 0);
  const broken = fixture({ spawnProcess: () => { throw new Error('spawn denied'); } });
  await assert.rejects(broken.run(spec, 'cwd', { id: 1 }), /spawn denied/);
  assert.equal(broken.pending.size, 0);
});

test('late cancellation response after close cannot kill peer or rearm timers', async () => {
  const state = Promise.withResolvers(), f = fixture({ getState: () => state.promise });
  const running = f.run(spec, 'cwd', { id: 1 });
  const polling = f.clock.fire(2);
  f.children[0].emit('close', 0); await running;
  state.resolve({ status: 'cancelled', cancel_requested: true }); await polling;
  assert.deepEqual(f.killed, []); assert.equal(f.pending.size, 0);
});
