import { MSToDoSession } from "./mcp-agent";
import { TodoIndex } from "./todo-index-do";
import { ownerIndex } from "@potem/core/owner-index";
import { appEnv } from "./env";
import { buildOAuthFront } from "./oauth";
import { handleUpload } from "@potem/core/upload/handler";
import { handleDownload } from "@potem/core/upload/download-handler";
import { handleWebhook } from "@potem/core/subscriptions/webhook-handler";
import { VERSION } from "@potem/core/version";
import { handleAppleAssociation } from "@potem/core/auth/apple-association";
import { sweepBlobs } from "@potem/core/blobs";
import { log } from "@potem/core/log";

const BLOB_SWEEP_HOUR_UTC = 8;

export { MSToDoSession, TodoIndex };

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const app = appEnv(env);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ ok: true, service: "mstodo-mcp", version: VERSION }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // The app's Associated Domains file (docs/SYNC-API.md section 8); null
    // unless APPLE_TEAM_ID and APPLE_BUNDLE_IDS are set.
    const association = handleAppleAssociation(req, app);
    if (association) return association;

    // Public (non-OAuth) web upload endpoint. Returns null for any other path so
    // OAuth/MCP routing below is unaffected. Lives before the OAuth front so
    // /upload is reachable without an OAuth access token (it authenticates with a
    // single-use signed link minted by create_upload_link).
    const uploadRes = await handleUpload(req, app);
    if (uploadRes) return uploadRes;

    // Public (non-OAuth) server-to-server download endpoint (ROADMAP §9). Same
    // null-for-other-paths contract as /upload; authenticates with a single-use
    // capability token minted by mint_download_link.
    const downloadRes = await handleDownload(req, app);
    if (downloadRes) return downloadRes;

    // Public (non-OAuth) Graph change-notification receiver (ROADMAP §4). Same
    // null-for-other-paths contract; needs ctx for the deferred (post-202) DO
    // call, so it's the one public handler that takes ctx.
    const webhookRes = await handleWebhook(req, app, ctx);
    if (webhookRes) return webhookRes;

    return buildOAuthFront(url.origin).fetch(req, env, ctx);
  },

  // Phase 5: cron heartbeat. Pokes the singleton TodoIndex DO to (re-)arm its
  // delta-sync alarm if it went idle. No sync work happens in the Worker itself
  // — ensureSyncing() is a no-op when an alarm is already pending, so the cron
  // only matters when the DO has gone quiet (e.g. after a no-auth alarm bailout
  // or a lost alarm).
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const index = ownerIndex(appEnv(env));
    ctx.waitUntil(index.ensureSyncing());
    // Once a day, the first cron run after 08:00 UTC: the blob sweep
    // (docs/SYNC-API.md section 4.9).
    const at = new Date(controller.scheduledTime);
    if (env.BLOBS && at.getUTCHours() === BLOB_SWEEP_HOUR_UTC && at.getUTCMinutes() < 15) {
      const blobs = env.BLOBS;
      ctx.waitUntil(
        sweepBlobs(blobs, index).catch((e: unknown) => log.error("blob_sweep_failed", { error: String(e) })),
      );
    }
  },
};
