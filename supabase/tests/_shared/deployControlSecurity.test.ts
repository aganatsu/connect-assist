import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const control = await Deno.readTextFile(
  new URL("../../functions/deploy-control/index.ts", import.meta.url),
);
const workflow = await Deno.readTextFile(
  new URL(
    "../../../.github/workflows/deploy-edge-functions.yml",
    import.meta.url,
  ),
);

Deno.test("deployment control requires a verified, allowlisted user", () => {
  assertStringIncludes(control, "resolveAuthenticatedUserId(req)");
  assertStringIncludes(control, "secretsMatch(userId, config.adminUserId)");
  assertStringIncludes(control, "Deployment access is restricted");
});

Deno.test("deployment credentials stay in server-side secrets", () => {
  assertStringIncludes(control, 'Deno.env.get("GITHUB_DEPLOY_TOKEN")');
  assert(!control.includes("VITE_GITHUB"));
  assertStringIncludes(workflow, "secrets.SUPABASE_ACCESS_TOKEN");
});

Deno.test("deployment always uses main and blocks concurrent runs", () => {
  assertStringIncludes(
    control,
    "`/repos/\${owner}/\${repo}/actions/workflows/\${config.workflow}/runs?event=workflow_dispatch&per_page=1`",
  );
  assertStringIncludes(control, 'JSON.stringify({ ref: "main" })');
  assertStringIncludes(control, 'latestRun?.status === "queued"');
  assertStringIncludes(control, 'latestRun?.status === "in_progress"');
  assertStringIncludes(workflow, "ref: main");
  assertStringIncludes(workflow, "cancel-in-progress: false");
});

Deno.test("workflow deploys all edge functions to the configured project", () => {
  assertStringIncludes(
    workflow,
    "supabase functions deploy --project-ref istpcfaokubxlualybhp",
  );
});
