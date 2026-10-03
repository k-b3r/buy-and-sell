# Matt Pocock's Skills

Source: https://github.com/mattpocock/skills (installed locally: `tdd`, `improve-codebase-architecture`, `triage`, `to-issues`, `to-prd`, `grill-me`, `diagnose`)

Principles encoded across the skills:

- ✅ **TDD in small, deliberate steps.** Red, green, refactor. Tight feedback loops stop errors compounding.
- ⚠️ **Tests go through public interfaces.** Test behavior a caller sees, not internal structure, so refactors don't break tests.
- ⚠️ **Deep modules** (from Ousterhout, _A Philosophy of Software Design_): lots of functionality behind a small, simple interface. Everything callers use goes through that interface. (Our `export *` barrels expose everything, which makes modules shallow.)
- ⚠️ **Clean seams.** Dependencies cross module boundaries at explicit points that tests can substitute.
- ✅ **Shared domain vocabulary** (DDD-style). One term per concept, recorded in a context doc (`CONTEXT.md` here). Cuts ambiguity and tokens.
- ✅ **Decisions recorded** in ADRs so they aren't relitigated.
- **Prototype to validate design** with throwaway code before committing to it.
- **Structured debugging**: feedback loop, hypothesis, instrument, fix, regression test.
- **Two-axis code review**: does it follow standards, and does it match the spec.
- Deliberate refactoring to fight entropy, not opportunistic.
