import { fileURLToPath } from 'node:url';

export const JOB_TOOLS = ['mcp__mailbot-job__notify_sender', 'mcp__mailbot-job__delegate_to_agent'];

// Token lives only in this MCP's env config; never in the CLI process environment.
export function jobMcp(job, url, entry = fileURLToPath(new URL('../mcp/job-tools.mjs', import.meta.url))) {
  if (!job.job_token || job.agent === 'agy') return null;
  return { command: process.execPath.replaceAll('\\', '/'), args: [entry.replaceAll('\\', '/')],
    env: { MAILBOT_URL: url, MAILBOT_JOB_TOKEN: job.job_token } };
}

export function codexMcpArgs(server) {
  // Reset inherited servers before declaring the one job-scoped server.
  const args = ['-c', 'mcp_servers={}'];
  if (server) {
    const tomlString = (s) => JSON.stringify(s);
    args.push('-c', `mcp_servers.mailbot-job.command=${tomlString(server.command)}`,
      '-c', `mcp_servers.mailbot-job.args=[${server.args.map(tomlString).join(',')}]`,
      '-c', `mcp_servers.mailbot-job.env={${Object.entries(server.env).map(([k,v]) => `${k}=${tomlString(v)}`).join(',')}}`);
  }
  return args;
}

export function cliEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(MAILBOT_JOB_TOKEN|MAILBOT_TOKEN|MAILBOT_ADMIN_TOKEN)$/i.test(key)));
}
