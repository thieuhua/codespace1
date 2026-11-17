#!/usr/bin/env node
// Deliberately separate from server.mjs: no public inbox tools here.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apiClient, toolCall } from './api.mjs';

export function createOrchestrator(config, fetchImpl, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now) {
  if (!/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(config.owner || '')) throw new Error('Thiếu owner hợp lệ');
  const api = apiClient({ url: config.url, token: config.admin_token }, fetchImpl);
  const server = new McpServer({ name: 'mailbot-orchestrator', version: '1.0.0' });
  const id = z.number().int().positive();
  server.tool('list_jobs', 'Liệt kê job gần nhất.', { limit: z.number().int().min(1).max(100).default(20) },
    toolCall(({ limit }) => api(`/jobs?limit=${limit}`)));
  server.tool('get_job', 'Đọc prompt, output, trạng thái và metadata outbox của job.', { id },
    toolCall(({ id }) => api(`/jobs/${id}`)));
  server.tool('submit_job', 'Gửi job cho agent từ owner cấu hình; có thể đợi tối đa 50 giây.', {
    agent: z.enum(['claude', 'codex', 'agy']), prompt: z.string().min(1).max(200000),
    project: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(), wait_seconds: z.number().int().min(0).max(50).default(0),
  }, toolCall(async ({ agent, prompt, project, wait_seconds }) => {
    let result = await api('/jobs', { agent, prompt, project, reply_to: config.owner });
    const deadline = now() + wait_seconds * 1000;
    while (now() < deadline && ['pending', 'running'].includes(result.job?.status)) {
      await sleep(Math.min(deadline - now(), 2000));
      const remaining = deadline - now();
      if (remaining <= 0) break;
      try { result = await api(`/jobs/${result.job.id}`, undefined, Math.min(10000, Math.max(1, Math.floor(remaining)))); }
      catch (e) { return { ...result, wait_error: e.message }; } // Job was submitted; retain its ID on polling failure.
    }
    return result;
  }));
  server.tool('cancel_job', 'Hủy job pending hoặc yêu cầu dừng job running.', { id },
    toolCall(({ id }) => api(`/jobs/${id}/cancel`, {})));
  server.tool('allowlist_list', 'Đọc whitelist, không sửa whitelist.', {}, toolCall(() => api('/allowlist')));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync(join(homedir(), '.mailbot', 'orchestrator.json'), 'utf8'));
  await createOrchestrator(config).connect(new StdioServerTransport());
}
