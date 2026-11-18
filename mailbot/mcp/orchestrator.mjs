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
  const ownerQuery=`owner=${encodeURIComponent(config.owner.toLowerCase())}`;
  server.tool('list_tasks', 'Liệt kê task của owner cấu hình.', { limit: z.number().int().min(1).max(100).default(20) },
    toolCall(({ limit }) => api(`/tasks?${ownerQuery}&limit=${limit}`)));
  server.tool('get_task', 'Đọc task và timeline events/runs/outbound.', { id },
    toolCall(({ id }) => api(`/tasks/${id}?${ownerQuery}`)));
  server.tool('answer_task', 'Trả lời task gốc của owner cấu hình đang chờ user; tính ngân sách owner.', {
    id, text:z.string().min(1).max(200000),
  },toolCall(({id,text})=>api(`/tasks/${id}/answer?${ownerQuery}`,{text})));
  server.tool('submit_task', 'Gửi task cho agent từ owner cấu hình; có thể đợi tối đa 50 giây.', {
    agent: z.enum(['claude', 'codex', 'agy']), prompt: z.string().min(1).max(200000),
    project: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(), wait_seconds: z.number().int().min(0).max(50).default(0),
  }, toolCall(async ({ agent, prompt, project, wait_seconds }) => {
    let result = await api('/tasks', { agent, prompt, project, owner: config.owner.toLowerCase() });
    const deadline = now() + wait_seconds * 1000;
    while (now() < deadline && ['active', 'waiting'].includes(result.task?.status)) {
      await sleep(Math.min(deadline - now(), 2000));
      const remaining = deadline - now();
      if (remaining <= 0) break;
      try { result = await api(`/tasks/${result.task.id}?${ownerQuery}`, undefined, Math.min(10000, Math.max(1, Math.floor(remaining)))); }
      catch (e) { return { ...result, wait_error: e.message }; } // Job was submitted; retain its ID on polling failure.
    }
    return result;
  }));
  server.tool('cancel_task', 'Hủy đồng bộ task và cây con, thu hồi token ngay.', { id },
    toolCall(({ id }) => api(`/tasks/${id}/cancel?${ownerQuery}`, {})));
  server.tool('allowlist_list', 'Đọc whitelist, không sửa whitelist.', {}, toolCall(() => api('/allowlist')));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync(join(homedir(), '.mailbot', 'orchestrator.json'), 'utf8'));
  await createOrchestrator(config).connect(new StdioServerTransport());
}
