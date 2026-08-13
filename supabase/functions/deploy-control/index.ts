import { corsHeaders } from "../_shared/cors.ts";
import {
  resolveAuthenticatedUserId,
  secretsMatch,
} from "../_shared/callerAuth.ts";

const GITHUB_API = "https://api.github.com";
const DEFAULT_REPOSITORY = "aganatsu/connect-assist";
const DEFAULT_WORKFLOW = "deploy-edge-functions.yml";

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function deploymentConfig() {
  return {
    token: Deno.env.get("GITHUB_DEPLOY_TOKEN") || "",
    adminUserId: Deno.env.get("DEPLOY_ADMIN_USER_ID") || "",
    repository: Deno.env.get("GITHUB_DEPLOY_REPOSITORY") || DEFAULT_REPOSITORY,
    workflow: Deno.env.get("GITHUB_DEPLOY_WORKFLOW") || DEFAULT_WORKFLOW,
  };
}

async function githubRequest(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const { token } = deploymentConfig();
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return respond({ error: "Method not allowed" }, 405);
  }

  const userId = await resolveAuthenticatedUserId(req);
  if (!userId) return respond({ error: "Unauthorized" }, 401);

  const config = deploymentConfig();
  if (!config.adminUserId || !secretsMatch(userId, config.adminUserId)) {
    return respond({
      error: "Deployment access is restricted",
      authorized: false,
    }, 403);
  }
  if (!config.token) {
    return respond({
      error: "GITHUB_DEPLOY_TOKEN is not configured",
      authorized: true,
    }, 503);
  }

  const body = await req.json().catch(() => ({}));
  const action = body.action || "status";
  const [owner, repo] = config.repository.split("/");
  if (!owner || !repo) {
    return respond(
      { error: "Invalid deployment repository configuration" },
      500,
    );
  }

  if (action === "permissions") {
    return respond({ authorized: true, configured: true });
  }

  if (action === "deploy") {
    const runsResponse = await githubRequest(
      `/repos/${owner}/${repo}/actions/workflows/${config.workflow}/runs?event=workflow_dispatch&per_page=1`,
    );
    if (runsResponse.ok) {
      const runsPayload = await runsResponse.json();
      const latestRun = Array.isArray(runsPayload?.workflow_runs)
        ? runsPayload.workflow_runs[0]
        : null;
      if (
        latestRun?.status === "queued" || latestRun?.status === "in_progress"
      ) {
        return respond({
          error: "A deployment is already running",
          runUrl: latestRun.html_url,
        }, 409);
      }
    }

    const response = await githubRequest(
      `/repos/${owner}/${repo}/actions/workflows/${config.workflow}/dispatches`,
      { method: "POST", body: JSON.stringify({ ref: "main" }) },
    );
    if (!response.ok) {
      const detail = await response.text();
      return respond({
        error: "GitHub rejected the deployment request",
        detail,
      }, 502);
    }
    return respond({
      ok: true,
      status: "queued",
      message: "Edge-function deployment queued",
    }, 202);
  }

  if (action === "status") {
    const response = await githubRequest(
      `/repos/${owner}/${repo}/actions/workflows/${config.workflow}/runs?event=workflow_dispatch&per_page=1`,
    );
    if (!response.ok) {
      const detail = await response.text();
      return respond(
        { error: "Unable to read deployment status", detail },
        502,
      );
    }
    const payload = await response.json();
    const run = Array.isArray(payload?.workflow_runs)
      ? payload.workflow_runs[0]
      : null;
    return respond({
      authorized: true,
      configured: true,
      run: run
        ? {
          id: run.id,
          status: run.status,
          conclusion: run.conclusion,
          createdAt: run.created_at,
          updatedAt: run.updated_at,
          url: run.html_url,
          commit: run.head_sha,
        }
        : null,
    });
  }

  return respond({ error: "Unknown action" }, 400);
});
