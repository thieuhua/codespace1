import { isServerSource, normalizeFields, validateContent } from '../../../shared/content/schema.js';
import { adapters } from './adapters/index.js';

const registry = new Map(Object.entries(adapters));
export function register(id, factory) { registry.set(id, factory); }
export function create(raw, { coalesceMs = 80 } = {}) {
  const config = validateContent(raw);
  const factory = isServerSource(config) ? () => ({ start() {}, stop() {} }) : registry.get(config.adapterId);
  if (!factory) throw new Error('Chưa đăng ký adapter.');
  let adapter, controller, externalSignal, abort, timer, pending, epoch = 0, good, sink, report, sourceStatus;
  function stop() {
    epoch++; controller?.abort(); clearTimeout(timer); timer = null; pending = undefined;
    externalSignal?.removeEventListener('abort', abort); adapter?.stop(); adapter = null; sink = report = null;
  }
  function start({ signal, onData = () => {}, onStatus = () => {} }) {
    stop(); good = undefined;
    if (signal?.aborted) return;
    const generation = epoch;
    controller = new AbortController(); externalSignal = signal; abort = stop;
    signal?.addEventListener('abort', abort, { once: true });
    const active = () => generation === epoch && !controller.signal.aborted;
    report = value => {
      if (!active()) return;
      sourceStatus = value;
      const state = value.state === 'error' && (good || pending) ? 'stale' : value.state;
      if (['loading', 'ready', 'stale', 'error'].includes(state)) onStatus({ state, reason: String(value.reason || '').slice(0, 500) });
    };
    sink = fields => {
      if (!active()) return;
      pending = normalizeFields(fields, config.fieldMap);
      sourceStatus = { state: 'ready' };
      // Fixed window: a fast feed cannot postpone delivery indefinitely.
      if (timer === null) timer = setTimeout(() => {
        timer = null;
        if (!active()) return;
        good = pending; pending = undefined; onData(good);
        if (active()) report(sourceStatus);
      }, coalesceMs);
    };
    const emitStatus = report, emitData = sink;
    emitStatus({ state: 'loading' });
    if (!active()) return;
    try {
      adapter = factory(config);
      Promise.resolve(adapter.start({ signal: controller.signal, onData: emitData, onStatus: emitStatus })).catch(error => emitStatus({ state: 'error', reason: error.message }));
    }
    catch (error) { emitStatus({ state: 'error', reason: error.message }); }
  }
  return { start, stop, push(fields) { sink?.(fields); }, status(value) { report?.(value); }, get lastGood() { return good; } };
}
