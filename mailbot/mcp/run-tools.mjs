#!/usr/bin/env node
// Run MCP never imports fs or reads files; attachments go through executor outbox.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { apiClient, toolCall } from './api.mjs';

export function createRunTools(config, fetchImpl) {
  const api=apiClient({...config,runToken:true},fetchImpl);
  const server=new McpServer({name:'mailbot-run',version:'2.0.0'});
  const text=z.string().min(1).max(200000);
  server.tool('reply','Ghi kết quả; gửi khi run hoàn tất an toàn. Lần gọi cuối thắng. Chỉ text.',{text},toolCall((b)=>api('/run-api/reply',b)));
  server.tool('spawn','Tạo task con ở agent khác, kế thừa project/owner; kết quả trả về cha.',{
    agent:z.enum(['claude','codex','agy']),prompt:text,
  },toolCall((b)=>api('/run-api/spawn',b)));
  server.tool('await','Chờ con trực tiếp chưa giao kết quả. Chỉ áp dụng lúc kết thúc run.',{
    ids:z.array(z.number().int().positive()).min(1).max(3),mode:z.enum(['all','any']).default('all'),
  },toolCall((b)=>api('/run-api/await',b)));
  server.tool('notify','Gửi tiến độ ngay, chỉ task gốc; chỉ text, tối đa 3/run.',{
    text:z.string().min(1).max(64000),
  },toolCall((b)=>api('/run-api/notify',b)));
  server.tool('ask_user','Chưa hỗ trợ; dành cho giai đoạn 4, chỉ task gốc.',{question:text},
    toolCall(async()=>{throw new Error('ask_user chưa hỗ trợ (giai đoạn 4)');}));
  return server;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  await createRunTools({url:process.env.MAILBOT_URL,token:process.env.MAILBOT_RUN_TOKEN}).connect(new StdioServerTransport());
}
