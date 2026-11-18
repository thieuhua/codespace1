// No filesystem, HTTP or CLI dependencies. Claim only after reserving capacity.
export function poolLimits(config = {}, log = () => {}) {
  const value = (key, fallback) => {
    if (config[key] === undefined) return fallback;
    if (Number.isSafeInteger(config[key]) && config[key] > 0) return config[key];
    log(`${key} không phải số nguyên dương; dùng mặc định ${fallback}`);
    return fallback;
  };
  return { maxParallel: value('max_parallel', 3), maxPerAgent: value('max_per_agent', 2) };
}

export function createRunPool({ agents, maxParallel = 3, maxPerAgent = 2, claim, execute,
  log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout,
  retryMs = 1000, maxRetryMs = 30000 }) {
  const names = [...new Set(agents)];
  if (![maxParallel, maxPerAgent].every(n => Number.isSafeInteger(n) && n > 0))
    throw new Error('Invalid run pool limits');
  const occupied = new Map(names.map(a => [a, 0]));
  const running = new Map(occupied);
  let total = 0, cursor = 0, filling = false, requested = false, closed = false;
  let fillPromise, retryTimer, failures = 0;
  const release = agent => { total--; occupied.set(agent, occupied.get(agent) - 1); };
  const report = message => { try { log(message); } catch { /* logging cannot break accounting */ } };

  function backoff(error) {
    if (closed) return;
    report(`claim run: ${error?.message || error}`);
    const delay = Math.min(maxRetryMs, retryMs * 2 ** Math.min(failures++, 16));
    retryTimer = setTimer(() => { retryTimer = undefined; wake(); }, delay);
  }

  async function fill() {
    do {
      requested = false;
      const empty = new Set();
      while (!closed && total < maxParallel) {
        let agent;
        for (let n = 0; n < names.length; n++) {
          const candidate = names[cursor++ % names.length];
          if (!empty.has(candidate) && occupied.get(candidate) < maxPerAgent) { agent = candidate; break; }
        }
        if (agent === undefined) break;
        // Synchronous reservation includes the in-flight claim, both globally
        // and for this agent. No claimed run ever queues behind another run.
        total++;
        occupied.set(agent, occupied.get(agent) + 1);
        let run;
        try {
          run = await claim([agent]);
          if (run && run.agent !== agent) throw new Error('Claim returned an unrequested agent');
          failures = 0;
        } catch (error) {
          release(agent);
          backoff(error);
          return;
        }
        if (!run) { release(agent); empty.add(agent); continue; }
        running.set(agent, running.get(agent) + 1);
        // Detached execution: one rejected run must never reject the fill loop.
        void Promise.resolve().then(() => execute(run)).catch(error => {
          report(`run #${run.id} ${agent}: ${error?.message || error}`);
        }).finally(() => {
          running.set(agent, running.get(agent) - 1);
          release(agent);
          wake();
        });
      }
    } while (requested && !closed && retryTimer === undefined);
  }

  function wake() {
    if (closed) return Promise.resolve();
    requested = true;
    if (filling) return fillPromise;
    if (retryTimer !== undefined) return Promise.resolve();
    filling = true; // Before any await, including simultaneous HTTP wakes.
    fillPromise = Promise.resolve().then(fill).finally(() => {
      filling = false;
      // A completion/wake may arrive after fill's last condition but before
      // this microtask. Preserve that request rather than waiting for polling.
      if (requested && !closed && retryTimer === undefined) wake();
    });
    return fillPromise;
  }

  return {
    wake,
    snapshot: () => ({ running: Object.fromEntries(running), occupied: total,
      claiming: total - [...running.values()].reduce((a, b) => a + b, 0) }),
    close() { closed = true; if (retryTimer !== undefined) clearTimer(retryTimer); },
  };
}
