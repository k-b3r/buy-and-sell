@AGENTS.md

- `tool`+`review` Data pages are `force-dynamic` (`export const dynamic = 'force-dynamic'`; no build-time dependency on the VPS). _(`tests/pages-dynamic.test.ts` checks every page importing `queries`; which pages count as data pages is review)_
