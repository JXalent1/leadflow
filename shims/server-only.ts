// Empty shim for the `server-only` package, used ONLY by tsx-run scripts/fixtures.
//
// `import "server-only"` is a build-time guard: in the Next.js build it resolves to Next's own
// alias (an empty module for Server Components, a throwing module for Client Components), which is
// what enforces the boundary. But our test fixtures and scripts run under tsx (plain Node), which
// has no such alias — and the published `server-only` package throws by default outside a
// React-Server build. This empty shim is mapped in tsconfig `paths` so tsx resolves the import to a
// no-op, while the real enforcement still happens in `next build`.
export {};
