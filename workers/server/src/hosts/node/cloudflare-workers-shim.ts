// Node stand-in for the `cloudflare:workers` module. The only thing
// @cloudflare/workers-oauth-provider imports from it is WorkerEntrypoint, and
// only for `handler.prototype instanceof WorkerEntrypoint` — deciding whether
// a handler is a class or a plain { fetch } object. Our handlers are plain
// objects, so an empty class gives the same answer the Workers runtime would.
// Wired in by a resolve.alias (vitest.config.ts node project; the Node build).
export class WorkerEntrypoint {}
