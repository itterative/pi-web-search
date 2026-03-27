# Development Rules

## References

### Architecture & Design

- [INFRASTRUCTURE.md](./docs/INFRASTRUCTURE.md) - Project structure, architecture, and design patterns
- [CONFIGURATION.md](./docs/CONFIGURATION.md) - Configuration reference

### Agent Guides

- [agent/summarizer-flow.md](./docs/agent/summarizer-flow.md) - Summarizer main loop and flow
- [agent/extension-lifecycle.md](./docs/agent/extension-lifecycle.md) - Extension hooks and lifecycle
- [agent/tools-overview.md](./docs/agent/tools-overview.md) - Tool implementations and patterns
- [agent/state-management.md](./docs/agent/state-management.md) - State types and positioning systems
- [agent/screenshot-system.md](./docs/agent/screenshot-system.md) - Screenshot capture and placeholder filling

## General

- When axon is available, prefer using its tools over bash commands (fallback)
- When using grep, find, or other similar tools, you should ignore node_modules unless necessary

## Code Quality

- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional

## Commands

- After code changes (not documentation changes): `npx prettier -c [FILES ...]` for warnings regarding code-style (you may pass -w flag instead if there are too many warnings to autofix)
- Note: `npm run check` does not run tests.
- NEVER run: `npm run dev`, `npm run build`
- Only run specific tests if user instructs: `npx vitest --run test/specific.test.ts`
- You may check compilation using `npx tsc --noEmit` on the entire project
- When writing tests, run them, identify issues in either the test or implementation, and iterate until fixed.
- NEVER commit unless user asks

## Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
