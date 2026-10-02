# TigerStyle (TigerBeetle)

Source: https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md

Design goal priority: safety > performance > developer experience. Written for Zig, but most rules are language-agnostic.

## Safety

- ⚠️ Simple, explicit control flow. No recursion unless provably bounded. (Our batch-halving recursion is bounded by batch size.)
- Minimal abstractions, only where they make domain sense.
- ✅ Put a limit on everything: every loop, queue, retry has a fixed upper bound.
- ➖ Explicitly sized types (u32/u64), not architecture-dependent ones.
- ➖ Assertion density: at least 2 assertions per function.
- Assert arguments, return values, pre/postconditions, invariants.
- Pair assertions: check a property on at least 2 different code paths.
- Split compound assertions: `assert(a); assert(b);` over `assert(a and b)`.
- ⚠️ Assert both positive space (what you expect) and negative space (what you don't).
- ⚠️ Tests cover valid and invalid data.
- ➖ All memory statically allocated at startup.
- Declare variables at the smallest possible scope.
- ➖ Hard limit: 70 lines per function.
- ⚠️ Centralize control flow in parent functions; push logic into helpers. Keep leaf functions pure.
- Strictest compiler warnings enabled.
- Don't react directly to external events; run at your own pace (batch them). (Fits the collector's self-paced loops.)
- Split compound conditions into nested if/else so every branch is handled.
- State invariants positively.
- ✅ Handle all errors explicitly.
- ✅ Always explain the why.
- ⚠️ Pass library options explicitly at the call site; don't rely on defaults. (Cf. the Groq `reasoningEffort` default truncating batches.)

## Performance

- Think about performance during design, not after.
- Back-of-envelope sketches for network, disk, memory, CPU.
- Optimize slowest resource first: network > disk > memory > CPU, weighted by frequency.
- Separate control plane from data plane.
- ✅ Amortize costs through batching.
- Give the CPU large, predictable chunks of work.
- Extract hot loops into standalone functions with primitive args.

## Naming

- Get nouns and verbs precisely right.
- ➖ `snake_case` for functions, variables, files.
- Don't abbreviate names (except loop indices in sort/matrix code).
- Long-form flags in scripts (`--force`, not `-f`).
- Capitalize acronyms consistently (`VSRState`, not `VsrState`).
- ⚠️ Units and qualifiers in names, descending significance: `latency_ms_max`, not `max_latency_ms`.
- Infuse names with meaning (`gpa: Allocator` vs `arena: Allocator`).
- Related names with the same length so they line up.
- Prefix helper names with the caller's name.
- Callbacks last in parameter lists.
- Important things at the top of the file; `main` first.
- Struct order: fields, types, methods.
- Don't overload one name with context-dependent meanings.
- Names that work as nouns in docs and conversation.
- ⚠️ Options object when positional args could be confused.
- Dependencies (e.g. allocators) passed positionally.

## Comments and commits

- Descriptive commit messages.
- Comments explain why; test descriptions explain how.
- Comments are full sentences: capital letter, ending punctuation.

## Cache invalidation (state bugs)

- Don't duplicate variables or create aliases.
- Minimize variables in scope.
- Compute or check values close to where they're used.
- Simpler return types win: void > bool > number > optional > error union.
- Functions run to completion without suspending (where possible).
- Group allocation and deallocation visually.

## Off-by-one

- ⚠️ Distinguish `index` (0-based), `count` (1-based), `size` (with units).
- Show intent in division: exact, floor, or ceil, explicitly.

## By the numbers

- Formatter is law (`zig fmt`).
- 4-space indent, 100-column hard limit.
- Braces on `if` unless single line.
- Trailing commas, let the formatter wrap.

## Dependencies

- ➖ Zero-dependency policy, single language for tools and scripts.
