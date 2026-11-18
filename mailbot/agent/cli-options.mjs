export const SECRET_DIRS = [".mailbot", ".ssh", ".aws", ".codex", ".claude", ".config", ".wrangler"];
export const GIT_READ_TOOLS = ["Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)"];

// Verified by local claude --help: restricted confines file tools to cwd and
// ignores user/project/local settings. Only reintroduce the allowlisted shell.
export function claudeIsolationArgs() {
  return ['--restricted', '--permission-prompts', 'none', '--tools', 'Read,Glob,Grep,Edit,Write,Bash'];
}

export function claudeSettings(home, workdir = '') {
  const unixHome = home.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  return JSON.stringify({ permissions: { deny: [
    ...SECRET_DIRS.flatMap((d) => [`Read(/${unixHome}/${d}/**)`, `Edit(/${unixHome}/${d}/**)`, `Bash(*${d}*)`]),
    ...['**/.git', '**/.git/**', '**/worktree-state/**', '**/task-state/**',
      ...(workdir ? ['worktree-state','task-state'].map(d => '/' + workdir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) + `/${d}/**`) : [])]
      .flatMap((p) => [`Read(${p})`, `Edit(${p})`]),
    ...["*--no-index*", "*--output*", "*--ext-diff*", "*-c *", "*core.*"].map((s) => `Bash(${s})`),
  ] } });
}

export function jobOptions(job) {
  let o = {};
  try { o = JSON.parse(job.options_json || "{}"); } catch {}
  if (!o || typeof o !== "object") o = {};
  return {
    new: o.new === true,
    model: typeof o.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(o.model) ? o.model : null,
    effort: /^(low|medium|high|xhigh|max)$/.test(o.effort || "") ? o.effort : null,
  };
}

// defaultModel: model mặc định theo agent từ agent.json (claude --restricted bỏ qua settings của user,
// nên phải truyền rõ model, nếu không CLI rơi về model mặc định có thể cần credit riêng).
export function optionArgs(agent, options, defaultModel) {
  const args = [];
  const model = options.model || defaultModel || null;
  if (model) args.push(agent === "codex" ? "-m" : "--model", model);
  if (options.effort) {
    if (agent === "codex") args.push("-c", `model_reasoning_effort="${options.effort === 'max' ? 'xhigh' : options.effort}"`);
    else args.push("--effort", options.effort);
  }
  return args;
}

export function claudeAllowedTools(project) {
  return [...GIT_READ_TOOLS, ...(Array.isArray(project?.claude_allowed_tools) ?
    project.claude_allowed_tools.filter((s) => typeof s === "string") : [])];
}
