import { execFile } from 'node:child_process';
import { codexDisableArgs, verifyCodexDisabled, cliEnv } from './run-mcp.mjs';

// No model calls, no config writes. Never include raw inventory/config in errors.
export function inspectCli(cmd, args, cwd) {
  return new Promise((resolve, reject) => execFile(cmd, args, {
    cwd, env: cliEnv(), windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024,
  }, (error, stdout) => error ? reject(new Error('Không kiểm tra được MCP CLI; không chạy job')) : resolve(stdout)));
}

export function codexInventoryCache(inspect = inspectCli) {
  const flights = new Map();
  return (entry, cwd) => {
    // Only overlapping checks share work. A writable cwd can gain project-local
    // servers during a run, so every subsequent run must inspect it again.
    const key = JSON.stringify([entry, cwd]);
    if (flights.has(key)) return flights.get(key);
    const flight = Promise.resolve().then(async () => {
      let servers;
      try { servers = JSON.parse(await inspect(process.execPath, [entry, '--disable', 'plugins', 'mcp', 'list', '--json'], cwd)); }
      catch { throw new Error('Không đọc được Codex MCP inventory; không chạy job'); }
      const args = codexDisableArgs(servers);
      let disabled;
      try { disabled = JSON.parse(await inspect(process.execPath, [entry, ...args, 'mcp', 'list', '--json'], cwd)); }
      catch { throw new Error('Không xác minh được Codex MCP isolation; không chạy job'); }
      verifyCodexDisabled(disabled);
      const safe = Object.freeze(servers.map(({ name, enabled }) => Object.freeze({ name, enabled })));
      return safe;
    }).finally(() => flights.delete(key));
    flights.set(key, flight);
    return flight;
  };
}

// Agy has no TTL cache: share only an overlapping inspection in the same cwd,
// then verify each caller's allowlist. The next run always inspects again.
export function agyMcpCheck(inspect = inspectCli) {
  const flights = new Map();
  return async (entry, cwd, allowed) => {
    const key = JSON.stringify([entry, cwd]);
    if (!flights.has(key)) {
      const flight = Promise.resolve().then(() => inspect(entry, ['mcp', 'list'], cwd))
        .finally(() => flights.delete(key));
      flights.set(key, flight);
    }
    verifyAgyMcp(await flights.get(key), allowed);
  };
}

export function agyEnabledServers(output) {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').trim().split(/\r?\n/).filter((s) => s.trim());
  if (lines.length === 1 && /^No MCP servers (configured|found)\.?$/i.test(lines[0].trim())) return [];
  if (!/^NAME\s+TYPE\s+STATUS\s+COMMAND\/URL\s*$/.test(lines.shift()?.trim() || ''))
    throw new Error('Không hiểu agy mcp list; không chạy job');
  return lines.flatMap((line) => {
    const row = line.trim().match(/^(\S+)\s+(\S+)\s+(enabled|disabled)(?:\s+.*)?$/);
    if (!row) throw new Error('Không hiểu trạng thái MCP agy; không chạy job');
    return row[3] === 'enabled' ? [row[1]] : [];
  });
}

export function verifyAgyMcp(output, allowed = []) {
  if (!Array.isArray(allowed) || allowed.some((s) => typeof s !== 'string' || !s)) throw new Error('agy_allowed_global_mcp phải là mảng tên MCP');
  const unexpected = agyEnabledServers(output).filter((s) => !allowed.includes(s));
  if (unexpected.length) throw new Error(`Agy MCP global chưa được cho phép: ${unexpected.join(', ')}. Tắt MCP hoặc cấu hình agy_allowed_global_mcp; không chạy job.`);
}
