# CLAUDE.md / Standards-File Meta Guidance

Sources:
- https://reliasoftware.com/blog/claude-md-file
- https://github.com/MuhammadUsmanGM/claude-code-best-practices

About the standards file itself.

- Treat it as a constitution: short, enforceable constraints, not documentation.
- ✅ Under ~200 lines. (Ours: 81.)
- Only rules that will still be true six months from now. Volatile facts go in memory or docs.
- Include do/don't pairs and point to key files as examples.
- ⚠️ Agents only follow what they load: reference `CODING_STANDARDS.md` from `CLAUDE.md` / `AGENTS.md`, or move the rules there.
- Grow it reactively: each agent mistake becomes one rule.
