# Contributing

## Getting Started

```bash
git clone https://github.com/kineticadb/admin-agent.git
cd admin-agent
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY
```

Run from source: `npm run dev`

## Development Workflow

1. **Branch from `main`** — use a descriptive branch name (`feat/add-xyz-tool`, `fix/sql-timeout`)
2. **Write tests first** (TDD) — create a `*.test.ts` file alongside the source file
3. **Run tests** — `npm test` (all tests), `npx vitest run path/to/file.test.ts` (single file)
4. **Type-check** — `npm run typecheck`
5. **Verify coverage** — `npm run test:coverage` (80% line threshold enforced)

## Commit Conventions

Use [conventional commits](https://www.conventionalcommits.org/):

```
feat: add kinetica_new_tool for X
fix: handle empty response from /show/table
refactor: extract shared parsing into rest utility
docs: document new playbook format
test: add coverage for edge case in metrics tool
chore: bump tsup to v8
```

## Code Style

- **Immutable data** — `readonly` fields, `ReadonlyMap`, no in-place mutation
- **Factory functions over classes** — `createFoo()` returning a closure, not `new Foo()`
- **Discriminated unions** — `ToolResult<T>` with `ok: true/false`, not exceptions
- **Graceful degradation** — return `undefined` or fallback on error, never throw from tools
- **Co-located tests** — every `foo.ts` has a sibling `foo.test.ts`
- **Linting and formatting** — `npm run lint` (ESLint with typescript-eslint) and `npm run format` (Prettier; `npm run format:check` for a read-only check). A dedicated CI `lint` job runs `npm run lint` and `npm run format:check` on every PR, so run them locally before pushing.

## Adding Tools

New tools go in `src/tools/rest/`, `src/tools/sql/`, or `src/tools/mutation/` depending on type. Each tool:

1. Takes `KineticaSession` and returns `ToolResult<T>`
2. Has a co-located `*.test.ts`
3. Is registered in `src/tools/index.ts` via the `tool()` helper
4. Gets added to the appropriate name list (`DIAGNOSTIC_TOOL_NAMES` or `MUTATION_TOOL_NAMES`)

Mutation tools must be annotated `{ destructive: true, readOnly: false }` and will trigger the approval gate.

## Adding Diagnostic Knowledge

Playbooks and references require no TypeScript — just Markdown with YAML frontmatter. See the [README](README.md#contributing-diagnostic-knowledge) for the full format and examples.

## Before opening a PR

Run these locally and confirm they all pass:

```bash
npm run typecheck
npm test
npm run build
```

## Questions?

Open an [issue](https://github.com/kineticadb/admin-agent/issues) or start a [discussion](https://github.com/kineticadb/admin-agent/discussions).
