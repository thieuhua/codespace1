export const SECRET_DIRS = [".mailbot", ".ssh", ".aws", ".codex", ".claude", ".config", ".wrangler"];
export const GIT_READ_TOOLS = ["Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)"];

export function claudeSettings(home) {
  const unixHome = home.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  return JSON.stringify({ permissions: { deny: [
    ...SECRET_DIRS.flatMap((d) => [`Read(/${unixHome}/${d}/**)`, `Edit(/${unixHome}/${d}/**)`, `Bash(*${d}*)`]),
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

export function optionArgs(agent, options, agyModel) {
  const args = [];
  const model = options.model || (agent === "agy" ? agyModel : null);
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
