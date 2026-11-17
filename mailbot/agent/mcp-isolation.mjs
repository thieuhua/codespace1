import { execFile } from 'node:child_process';
import { codexDisableArgs, verifyCodexDisabled, cliEnv } from './job-mcp.mjs';

// No model calls, no config writes. Never include raw inventory/config in errors.
export function inspectCli(cmd, args, cwd) {
  return new Promise((resolve, reject) => execFile(cmd, args, {
    cwd, env: cliEnv(), windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024,
  }, (error, stdout) => error ? reject(new Error('Không kiểm tra được MCP CLI; không chạy job')) : resolve(stdout)));
}

export function codexInventoryCache(inspect = inspectCli, now = Date.now) {
  let cached;
  return async (entry, cwd) => {
    if (cached?.entry === entry && now() - cached.at < 600000) return cached.servers;
    let servers;
    try { servers = JSON.parse(await inspect(process.execPath, [entry, '--disable', 'plugins', 'mcp', 'list', '--json'], cwd)); }
    catch { throw new Error('Không đọc được Codex MCP inventory; không chạy job'); }
    const args = codexDisableArgs(servers);
    let disabled;
    try { disabled = JSON.parse(await inspect(process.execPath, [entry, ...args, 'mcp', 'list', '--json'], cwd)); }
    catch { throw new Error('Không xác minh được Codex MCP isolation; không chạy job'); }
    verifyCodexDisabled(disabled);
    cached = { entry, at: now(), servers: servers.map(({ name, enabled }) => ({ name, enabled })) };
    return cached.servers;
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
