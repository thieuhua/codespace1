#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { apiClient, toolCall } from './api.mjs';

export function createJobTools(config, fetchImpl) {
  const api = apiClient({ ...config, jobToken: true }, fetchImpl);
  const server = new McpServer({ name: 'mailbot-job', version: '1.0.0' });
  server.tool('notify_sender', 'Gửi cập nhật tới người gửi job hiện tại, tối đa 3 thư.', {
    subject: z.string().min(1).max(300), body: z.string().min(1).max(200000),
  }, toolCall((body) => api('/job-api/notify', body)));
  server.tool('delegate_to_agent', 'Nhờ agent khác làm job con, tối đa 2 job, chỉ 1 cấp; kết quả gửi về người gửi gốc.', {
    agent: z.enum(['claude', 'codex', 'agy']), prompt: z.string().min(1).max(200000),
  }, toolCall((body) => api('/job-api/delegate', body)));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createJobTools({ url: process.env.MAILBOT_URL, token: process.env.MAILBOT_JOB_TOKEN });
  await server.connect(new StdioServerTransport());
}
