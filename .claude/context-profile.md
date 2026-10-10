# Context profile

Decision log for `.claude/settings.local.json` (written by `/init-context`). Settings apply from the next session.

## 2026-10-01

Baseline: 34.7k tokens loaded before the first agent action (measured on 6 subagent runs).

| Item | Action | Why | Undo |
|---|---|---|---|
| `shopify-ai-toolkit@claude-plugins-official` | `enabledPlugins: false` | No Shopify in this repo; 22 skills, ~2.5k tokens | delete the key |
| claude.ai connectors (Gmail, Calendar, Drive, Linear, Notion, Claude Docs) | `disableClaudeAiConnectors: true` | No issue tracker or docs tool used here; all-or-nothing switch | delete the key |
| synced claude.ai skills (docx, pdf, pptx, xlsx, ...) | `syncClaudeAiSkills: false` | No Office/PDF work here | delete the key |
| `setup-matt-pocock-skills` | `skillOverrides: user-invocable-only` | One-time setup; still runnable via `/setup-matt-pocock-skills` | set to `on` or delete |

Kept: `frontend-design` (Next.js dashboard), `caveman`, all other personal skills, project Playwright MCP.

## 2026-10-03

| Item | Action | Why | Undo |
|---|---|---|---|
| `superpowers@claude-plugins-official` | `enabledPlugins: false` | Trial: overlaps own skills (tdd, diagnose, grill-me, spike-and-rebuild, address-pr-review) + native plan mode/worktrees; SessionStart prompt pushes ceremony. Planning moves to plan mode + Plannotator | delete the key |
| `plannotator@plannotator` | installed, `--scope local` | Plan review UI on ExitPlanMode. Binary v0.27.25 in `~/.local/bin` (minimal install, SLSA verified) | `claude plugin uninstall plannotator@plannotator`; `plannotator uninstall` |

Verify: run `/context` in a new session and compare against the baseline.

## 2026-10-06

| Item | Action | Why | Undo |
|---|---|---|---|
| claude.ai connectors | removed `disableClaudeAiConnectors` | 2026-10-01 entry wrong: project tracks work on Linear BUY board; switch is all-or-nothing so other connectors load too | set `disableClaudeAiConnectors: true` |
| `setup-matt-pocock-skills` override | removed | skill uninstalled globally (with standalone `caveman`, `triage`, `to-prd`, `zoom-out`) via `npx skills remove --global`: duplicates or unused here | `npx skills add mattpocock/skills` |
| `superpowers@claude-plugins-official` | disabled globally (`~/.claude/settings.json`); local override removed | Trial ended: every useful skill has an own counterpart (mapping in session 2026-10-06: plan mode/Plannotator, spike-and-rebuild, dispatch-tickets, address-pr-review, tdd, diagnose, write-a-skill, CI agent review) | `claude plugin enable superpowers@claude-plugins-official --scope user` |
