/** Inherited system rules plus the worker's launch-time instructions. */
import type { AgentConfig, EnvInfo } from "./types.js";

export interface PromptExtras {
  memoryBlock?: string;
  skillBlocks?: { name: string; content: string }[];
  worktreeBase?: string;
}

export function buildAgentPrompt(
  config: AgentConfig,
  cwd: string,
  env: EnvInfo,
  parentSystemPrompt?: string,
  extras?: PromptExtras,
): string {
  const identity = parentSystemPrompt || "You are a coding assistant. Complete the assigned task within its authorization boundaries.";
  const bridge = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
Keep the work and relevant follow-ups with this session. Respect inherited rules and authorization boundaries.
Do not delegate. Report further work or coordination needs to the main agent.
Use absolute file paths. Be concise but complete.
Unless the task requires a specific output format, open your final response with 1–2 short sentences: the concrete outcome or findings, then verification and any unresolved limitation. Put supporting details afterward. Skip preambles, headings, and file lists before this summary; do not claim checks you did not run.
</sub_agent_context>`;
  const envBlock = `# Environment
Working directory: ${cwd}
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : "Not a git repository"}
Platform: ${env.platform}`;
  const worktreeBlock = extras?.worktreeBase
    ? `\n\n<worktree_isolation>\nYour working directory is an isolated git worktree copy of ${extras.worktreeBase}.\nWork only inside it — never in ${extras.worktreeBase}, even if other instructions name that path as your working directory.\n</worktree_isolation>`
    : "";
  const instructions = config.instructions?.trim()
    ? `\n\n<agent_instructions>\n${config.instructions}\n</agent_instructions>` : "";
  const extraSections = [
    extras?.memoryBlock,
    ...(extras?.skillBlocks ?? []).map(skill => `# Preloaded Skill: ${skill.name}\n${skill.content}`),
  ].filter(Boolean);
  const suffix = extraSections.length ? `\n\n${extraSections.join("\n\n")}` : "";
  // The inherited prefix is verbatim, allowing the provider to reuse its cache.
  return `${identity}\n\n${bridge}\n\n${envBlock}${worktreeBlock}${instructions}${suffix}`;
}
