# Google TypeScript Style Guide

Source: https://google.github.io/styleguide/tsguide.html

## Modules and exports

- ✅ ES modules only. No `namespace`.
- ✅ No default exports; named exports only.
- ⚠️ No mutable exports (`export let`); expose a getter function instead.
- Relative imports within the same project.

## Variables and types

- ✅ `const` by default, `let` only when reassigned, never `var`.
- ✅ Avoid `any`; prefer `unknown` and narrow.
- ⚠️ Type assertions (`as`) and non-null assertions (`!`) need a reason, ideally a comment.
- ⚠️ No `@ts-ignore` / `@ts-expect-error` to silence errors; fix the types.
- No `const enum`; plain `enum` is fine.
- ➖ Prefer `interface` over `type` alias for object shapes.
- ➖ Explicit annotations where inference would hide intent. (Guide allows inference for trivially obvious types.)
- `readonly` for properties never reassigned after construction.
- No `#private` fields; use TS `private`.

## Naming

- `UpperCamelCase`: classes, interfaces, types, enums, type params.
- `lowerCamelCase`: variables, params, functions, methods, properties.
- ✅ `CONSTANT_CASE`: module-level constants and enum values.
- ASCII identifiers only.

## Syntax

- ✅ Single quotes; template literals for interpolation or multiline.
- `===` / `!==` always.
- Braces on every control-flow block, even one-liners.
- No unfiltered `for...in`; use `for...of` / `Object.keys`.
- Function declarations for named functions; arrows for callbacks.
- No rebinding `this`; use arrows or explicit params.

## Errors

- ⚠️ Only throw `Error` (or subclasses), never strings or plain objects.
- ⚠️ Empty `catch` blocks need a comment explaining why.

## Comments

- `/** JSDoc */` for docs users of the code read; `//` for implementation notes.
- ➖ JSDoc on all exported API.
