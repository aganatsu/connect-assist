# Edge Function Redeploy Control

The Scheduled Tasks page can redeploy every production Supabase edge function from `main`.
The browser never receives a GitHub or Supabase deployment credential.

## One-time bootstrap

1. Create a fine-grained GitHub token limited to `aganatsu/connect-assist` with:
   - Actions: Read and write
   - Contents: Read
2. Add these secrets to the Lovable/Supabase Edge Function environment:
   - `DEPLOY_ADMIN_USER_ID`: the Supabase Auth UUID of the only user allowed to deploy
   - `GITHUB_DEPLOY_TOKEN`: the fine-grained GitHub token
3. Add this GitHub Actions repository secret:
   - `SUPABASE_ACCESS_TOKEN`: a Supabase personal access token allowed to deploy project `istpcfaokubxlualybhp`
4. Deploy `deploy-control` once using Lovable Cloud or the Supabase dashboard.
5. Deploy the frontend once so the button appears on Scheduled Tasks.

After bootstrap, **Redeploy All** triggers `.github/workflows/deploy-edge-functions.yml`.
The workflow always checks out `main`; it never deploys an unmerged branch.

## Scope

Included:
- every directory under `supabase/functions`

Not included:
- SQL migrations
- frontend deployment
- GitHub or Supabase secret changes

## Security

- A valid Supabase user JWT is required.
- The JWT user ID must exactly match `DEPLOY_ADMIN_USER_ID`.
- Credentials remain server-side.
- Concurrent duplicate deployments are rejected.
