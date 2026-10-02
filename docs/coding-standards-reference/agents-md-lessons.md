# Lessons from 2,500 agents.md Files (GitHub Blog)

Source: https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/

About how to write standards that agents follow, not about code style itself.

- ⚠️ Commands early, exact, with flags (`pnpm test`, `pnpm collect`), not just tool names.
- ⚠️ One real code snippet beats several paragraphs describing style.
- ⚠️ Three-tier boundaries:
  - **Always do**: e.g. run tests before commit.
  - **Ask first**: e.g. schema changes, VPS deploys, live FB runs.
  - **Never do**: e.g. commit secrets, scrape NO-GO sources, force-push main.
- ⚠️ Name the stack precisely, with versions (Next 16, Vitest 2, PG 18, pnpm).
- Cover six areas: commands, testing, project structure, code style, git workflow, boundaries.
- ➖ Give each agent a clear role / persona and one narrow task (suits multi-agent repos).
- ➖ YAML frontmatter with name and description.
- File-level permissions: which dirs the agent reads vs writes.
- Start minimal; add a rule each time an agent makes a mistake.

## Related

- 6 AGENTS.md examples from real production repos: https://ssojet.com/blog/agents-md-examples
