// The slice of the Workers ExecutionContext global that host-neutral code
// (src/core, src/hosts/shared) uses, for the Node typecheck
// (tsconfig.node.json). The Node host builds its own object of this shape
// (src/hosts/node/http.ts). Kept outside src/ so the main tsconfig, which
// loads the full Workers types, never sees a second, conflicting declaration.
interface ExecutionContext<Props = unknown> {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  readonly props: Props;
}
