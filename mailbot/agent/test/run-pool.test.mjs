import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunPool, poolLimits } from '../run-pool.mjs';

const deferred = () => Promise.withResolvers();
const turn = () => new Promise(resolve => setImmediate(resolve));

function timers() {
  const pending = new Map(); let id = 0;
  return {
    pending,
    setTimer(fn, ms) { pending.set(++id, { fn, ms }); return id; },
    clearTimer(id) { pending.delete(id); },
    async next() { const [id, { fn }] = pending.entries().next().value; pending.delete(id); fn(); await turn(); },
  };
}

test('positive integer limits: defaults, invalid values logged, valid values retained', () => {
  assert.deepEqual(poolLimits(), { maxParallel: 3, maxPerAgent: 2 });
  for (const bad of [0, -1, 1.5, '2', null, false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const logs = [];
    assert.deepEqual(poolLimits({ max_parallel: bad, max_per_agent: bad }, s => logs.push(s)), { maxParallel: 3, maxPerAgent: 2 });
    assert.equal(logs.length, 2); assert.match(logs[0], /max_parallel/); assert.match(logs[1], /max_per_agent/);
  }
  assert.deepEqual(poolLimits({ max_parallel: 4, max_per_agent: 1 }), { maxParallel: 4, maxPerAgent: 1 });
});

test('wake storms reserve before claim, serialize fills and respect total/per-agent limits', async t => {
  const started = [], controls = new Map(), agents = ['claude', 'codex', 'agy'];
  let claims = 0, inClaim = 0, peakClaims = 0, available = true;
  const pool = createRunPool({ agents, maxParallel: 3, maxPerAgent: 2,
    claim: async ([agent]) => {
      peakClaims = Math.max(peakClaims, ++inClaim);
      assert.ok(pool.snapshot().occupied <= 3); assert.equal(pool.snapshot().claiming, 1);
      await turn(); inClaim--;
      return available ? { id: ++claims, agent } : null;
    },
    execute: run => {
      const counts = pool.snapshot().running;
      assert.ok(Object.values(counts).every(n => n <= 2));
      assert.ok(Object.values(counts).reduce((a, b) => a + b, 0) <= 3);
      const d = deferred(); controls.set(run.id, d); started.push(run); return d.promise;
    },
  });
  t.after(() => pool.close());
  await Promise.all(Array.from({ length: 100 }, () => pool.wake())); await turn();
  assert.equal(started.length, 3); assert.equal(claims, 3); assert.equal(peakClaims, 1);
  for (let i = 0; i < 20; i++) {
    const [id, d] = controls.entries().next().value; controls.delete(id); d.resolve();
    await turn(); await pool.wake(); await turn();
    assert.equal(pool.snapshot().occupied, 3);
  }
  available = false;
  for (const d of controls.values()) d.resolve();
  await turn(); await pool.wake(); await turn();
  assert.equal(pool.snapshot().occupied, 0);
});

test('a full agent is never requested while other agents keep filling and finishing', async t => {
  const held = [], asked = []; let id = 0, allow = true;
  const pool = createRunPool({ agents: ['claude', 'codex'], maxParallel: 3, maxPerAgent: 2,
    claim: async ([agent]) => {
      asked.push(agent);
      assert.ok(pool.snapshot().running[agent] < 2);
      return allow ? { agent, id: ++id } : null;
    },
    execute: run => { const d = deferred(); held.push({ ...run, ...d }); return d.promise; },
  });
  t.after(() => pool.close());
  await pool.wake(); await turn();
  assert.deepEqual(pool.snapshot().running, { claude: 2, codex: 1 });
  const before = asked.length;
  held.find(r => r.agent === 'codex').resolve();
  await turn(); await pool.wake(); await turn();
  assert.deepEqual(asked.slice(before), ['codex']);
  assert.deepEqual(pool.snapshot().running, { claude: 2, codex: 1 });
  allow = false; held.forEach(r => r.resolve()); await turn();
});

test('throw/rejection from one run returns its slot and refills without waking or stopping its peer', async t => {
  const peer = deferred(), replacement = deferred(), logs = []; let id = 0;
  const pool = createRunPool({ agents: ['claude'], maxParallel: 2, maxPerAgent: 2, log: s => logs.push(s),
    claim: async () => id < 3 ? { agent: 'claude', id: ++id } : null,
    execute: run => { if (run.id === 1) throw new Error('CLI crash'); return run.id === 2 ? peer.promise : replacement.promise; },
  });
  t.after(() => pool.close());
  await pool.wake(); await turn();
  assert.equal(id, 3); assert.equal(pool.snapshot().running.claude, 2);
  assert.match(logs.join(' '), /CLI crash/);
  replacement.reject(new Error('failed finalize')); await turn();
  assert.equal(pool.snapshot().running.claude, 1);
  peer.resolve(); await turn(); assert.equal(pool.snapshot().occupied, 0);
});

test('failed claim releases reservation, backoff survives wakes and completion; retry fills automatically', async t => {
  const clock = timers(), held = [], logs = []; let calls = 0;
  const pool = createRunPool({ agents: ['claude'], maxParallel: 2, maxPerAgent: 2, ...clock, log: s => logs.push(s),
    claim: async () => { calls++; if (calls === 2 || calls === 3) throw new Error('network offline'); return calls <= 4 ? { agent: 'claude', id: calls } : null; },
    execute: () => { const d = deferred(); held.push(d); return d.promise; },
  });
  t.after(() => pool.close());
  await pool.wake(); await turn();
  assert.equal(pool.snapshot().occupied, 1); assert.equal(pool.snapshot().claiming, 0);
  await Promise.all(Array.from({ length: 50 }, () => pool.wake())); assert.equal(calls, 2);
  held[0].resolve(); await turn(); assert.equal(pool.snapshot().occupied, 0); assert.equal(calls, 2);
  assert.equal([...clock.pending.values()][0].ms, 1000);
  await clock.next(); assert.equal(pool.snapshot().occupied, 0); assert.equal(calls, 3);
  assert.equal([...clock.pending.values()][0].ms, 2000);
  await clock.next(); assert.equal(calls, 5); assert.equal(pool.snapshot().running.claude, 1);
  held[1].resolve(); await turn(); assert.equal(pool.snapshot().occupied, 0);
  assert.equal(logs.length, 2);
});

test('wake received during an empty claim is not lost', async t => {
  const claimGate = deferred(), work = deferred(); let calls = 0;
  const pool = createRunPool({ agents: ['agy'], maxParallel: 1,
    claim: () => ++calls === 1 ? claimGate.promise : calls === 2 ? { agent: 'agy', id: 2 } : null,
    execute: () => work.promise,
  });
  t.after(() => pool.close());
  const first = pool.wake(); await turn(); pool.wake(); claimGate.resolve(null);
  await first; await turn(); assert.equal(pool.snapshot().running.agy, 1);
  work.resolve(); await turn();
});

test('non-Error claim and run rejections cannot crash accounting or the fill loop', async t => {
  const clock = timers(), logs = []; let calls = 0;
  const pool = createRunPool({ agents: ['codex'], ...clock, log: s => logs.push(s),
    claim: async () => { if (++calls === 1) throw null; return calls === 2 ? { agent: 'codex', id: 1 } : null; },
    execute: () => Promise.reject(undefined),
  });
  t.after(() => pool.close());
  await pool.wake(); assert.equal(pool.snapshot().occupied, 0);
  await clock.next(); assert.equal(pool.snapshot().occupied, 0);
  assert.match(logs[0], /claim run: null/); assert.match(logs[1], /run #1 codex: undefined/);
});
