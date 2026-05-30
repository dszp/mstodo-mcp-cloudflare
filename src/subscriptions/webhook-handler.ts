import { z } from "zod";
import { log } from "../log";
import { ownerIndex } from "../upload/handler";
import { taskSubscriptionsEnabled } from "./gate";

// Public (non-OAuth) Graph change-notification receiver (ROADMAP §4). Same
// null-for-other-paths contract as /upload and /download. Two jobs:
//   1. Subscription-creation handshake: Graph POSTs ?validationToken=<opaque>;
//      we MUST echo it back as text/plain 200 within 10s. Synchronous + DO-free
//      (the DO is blocked inside postJson during create; re-entering it here
//      could deadlock the handshake).
//   2. Real notification: ack 202 within 3s (Graph marks slow/unresponsive
//      endpoints and drops notifications), then validate clientState + trigger a
//      read-only refresh inside ctx.waitUntil. clientState is checked
//      post-ack — triggering a sync is read-only, so a forged notification gets
//      a 202 but causes no work; clientState is defense-in-depth.

const NotificationItemSchema = z
  .object({
    subscriptionId: z.string().optional(),
    clientState: z.string().optional(),
    changeType: z.string().optional(),
    // Basic notification carries the changed task id here (no resource data).
    resourceData: z.object({ id: z.string().optional() }).passthrough().nullish(),
  })
  .passthrough();
const NotificationBodySchema = z.object({ value: z.array(NotificationItemSchema) }).passthrough();

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
function ack(status: number): Response {
  return new Response(null, { status });
}

export async function handleWebhook(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/webhook") return null;

  // (1) Validation handshake — echo the (already URL-decoded) token. This works
  // even with the gate notionally off: it only proves we own the URL, and we
  // only ever create subscriptions when enabled.
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken !== null) {
    return text(validationToken);
  }

  if (req.method !== "POST") return ack(405);

  // (2) Real notification — parse, ack immediately, defer the rest.
  let parsed: z.infer<typeof NotificationBodySchema> | null = null;
  try {
    parsed = NotificationBodySchema.parse(await req.json());
  } catch {
    // Our parse failure must not make Graph retry for 4h. Ack and drop.
    log.info("webhook_unparseable");
    return ack(202);
  }

  if (taskSubscriptionsEnabled(env) && parsed.value.length > 0) {
    const items = parsed.value.map((v) => ({
      subscriptionId: v.subscriptionId,
      clientState: v.clientState,
      changeType: v.changeType,
      resourceId: v.resourceData?.id,
    }));
    ctx.waitUntil(
      ownerIndex(env)
        .onChangeNotification(items)
        .then((r) => log.info("webhook_processed", { accepted: r.accepted, rejected: r.rejected }))
        .catch((e) => log.warn("webhook_process_failed", { error: String(e) })),
    );
  }
  return ack(202);
}
