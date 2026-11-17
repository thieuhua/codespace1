import { fileURLToPath } from 'node:url';

export const RUN_TOOLS = ['reply', 'spawn', 'await', 'notify', 'ask_user'].map((name) => `mcp__mailbot-run__${name}`);

// Token lives only in this MCP's env config; never in the CLI process environment.
export function runMcp(job, url, entry = fileURLToPath(new URL('../mcp/run-tools.mjs', import.meta.url))) {
  if (!job.run_token || job.agent === 'agy') return null;
  return { command: process.execPath.replaceAll('\\', '/'), args: [entry.replaceAll('\\', '/')],
    env: { MAILBOT_URL: url, MAILBOT_RUN_TOKEN: job.run_token } };
}

export function codexDisableArgs(servers) {
  if (!Array.isArray(servers) || servers.some((s) => !s || typeof s.name !== 'string' || !s.name || typeof s.enabled !== 'boolean'))
    throw new Error('Codex MCP inventory không hợp lệ');
  return ['--disable', 'plugins', ...servers.flatMap(({ name }) =>
    ['-c', `mcp_servers.${/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)}.enabled=false`])];
}

export function verifyCodexDisabled(servers) {
  codexDisableArgs(servers);
  if (servers.some((s) => s.enabled !== false)) throw new Error('Codex vẫn còn MCP global enabled; không chạy job');
}

export function codexMcpArgs(server, servers = []) {
  const args = codexDisableArgs(servers);
  if (server) {
    const tomlString = (s) => JSON.stringify(s);
    args.push('-c', 'mcp_servers.mailbot-run.enabled=true',
      '-c', `mcp_servers.mailbot-run.command=${tomlString(server.command)}`,
      '-c', `mcp_servers.mailbot-run.args=[${server.args.map(tomlString).join(',')}]`,
      '-c', `mcp_servers.mailbot-run.env={${Object.entries(server.env).map(([k,v]) => `${k}=${tomlString(v)}`).join(',')}}`);
  }
  return args;
}

export function cliEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(MAILBOT_RUN_TOKEN|MAILBOT_JOB_TOKEN|MAILBOT_TOKEN|MAILBOT_ADMIN_TOKEN)$/i.test(key)));
}
