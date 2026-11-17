#!/usr/bin/env node
// Quản trị mailbot: node mailbot-admin.mjs <lệnh>
//   allow <địa_chỉ> [claude|codex|agy|*]   thêm vào whitelist (mặc định * = mọi agent)
//   deny  <địa_chỉ> [claude|codex|agy|*]   xóa khỏi whitelist
//   list                                    xem whitelist
//   jobs [số_lượng]                         xem job gần nhất
//   wake                                    gọi /wake của agent cục bộ (kiểm tra agent sống)
//   worktrees                               liệt kê worktree do mailbot quản lý
//   prune <tag>                             chỉ xóa worktree sạch và nhánh đã merge
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listWorktrees, pruneWorktrees } from './worktrees.mjs';

const cfg = JSON.parse(readFileSync(join(homedir(), ".mailbot", "agent.json"), "utf8"));
const base = (cfg.url || "https://mailbot.thieupro666.workers.dev").replace(/\/+$/, "");

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${cfg.admin_token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${data.error || res.statusText}`);
  return data;
}

const [cmd, a1, a2] = process.argv.slice(2);
switch (cmd) {
  case 'worktrees':
    console.log(JSON.stringify(listWorktrees(cfg.workdir || 'E:\\mailbot-work'), null, 2));
    break;
  case 'prune':
    console.log(JSON.stringify(pruneWorktrees(cfg.workdir || 'E:\\mailbot-work', cfg.projects, a1), null, 2));
    break;
  case "allow":
    await api("POST", "/allowlist", { address: a1, agent: a2 || "*" });
    console.log(`Đã cho phép ${a1} -> ${a2 || "*"}`);
    break;
  case "deny":
    await api("DELETE", "/allowlist", { address: a1, agent: a2 || "*" });
    console.log(`Đã xóa ${a1} -> ${a2 || "*"}`);
    break;
  case "list": {
    const { allowlist } = await api("GET", "/allowlist");
    if (!allowlist.length) console.log("(whitelist trống)");
    for (const r of allowlist) console.log(`${r.address}\t${r.agent}\t${r.added_at}`);
    break;
  }
  case "jobs": {
    const { jobs } = await api("GET", `/jobs?limit=${Number(a1) || 10}`);
    for (const j of jobs) {
      console.log(`#${j.id} ${j.agent} ${j.status}${j.reply_status ? `/${j.reply_status}` : ""} ${j.created_at} ${j.sender} | ${j.subject || ""}`);
      if (j.reply_error) console.log(`    reply_error: ${j.reply_error}`);
    }
    break;
  }
  case "wake": {
    const res = await fetch(`http://127.0.0.1:${cfg.port || 20025}/wake`, {
      method: "POST", headers: { authorization: `Bearer ${cfg.admin_token}` },
    });
    console.log(`agent cục bộ: ${res.status}`);
    break;
  }
  default:
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 10).join("\n"));
}
