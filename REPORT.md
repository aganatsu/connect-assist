# Task: fix-source-guards
## Branch: manus/fix-source-guards
## Behavior changes
none — pure infrastructure fix (test runner configuration)

## Files modified
- `deno.json` (NEW): Defines `deno task test` with correct `--allow-read --allow-net --allow-env` flags, fixing all 29 permission-gated test failures. Also adds `"exclude": ["node_modules/"]` to prevent Deno from scanning irrelevant directories.

## Root cause analysis
All 29 test failures were caused by a **missing permissions issue**, not stale grep patterns or outdated guards. The guard tests in `crossImplementationSync.test.ts` use `Deno.readTextFileSync()` to read source files and verify that shared functions are not re-duplicated. Without `--allow-read`, every `readTextFileSync` call throws a `PermissionDenied` error, causing the test to fail.

The repo had no `deno.json` defining a canonical test command, so developers had to remember the exact flags. This fix makes `deno task test` the single correct way to run the suite.

## Tests added
No new test files — the fix is to the test runner configuration itself. The existing 1603 tests (including all 29 guard tests) now pass correctly.

## Guard load-bearing proof
To verify the guards are not decorative assertions, a deliberate re-duplication was introduced and then removed:

1. **Injected** a local `function resolveSymbol(s: string): string { return s; }` into `bot-scanner/index.ts` (simulating the exact re-duplication the guards are designed to catch)
2. **Ran** `deno test --filter "GUARD: resolveSymbol is only defined"` → **FAILED** with:
   ```
   AssertionError: resolveSymbol re-defined outside canonical location:
     bot-scanner/index.ts:109
   ```
3. **Removed** the local function
4. **Ran** the same test → **PASSED**

This proves the guard catches real regressions when given proper file-read permissions.

## Tests run
```
$ deno task test
ok | 1603 passed | 0 failed (18s)
```

## Regression check
- No code logic was changed — only a `deno.json` configuration file was added
- The test suite output is identical to running with manual flags: `deno test --no-check --allow-read --allow-net --allow-env supabase/functions/_shared/`
- `bot-scanner/index.ts` has zero diff (verified via `git diff`)

## Open questions
None.

## Suggested PR title and description
**Title:** `[fix-source-guards] Add deno.json with canonical test task`

**Description:**
All 29 guard-test failures were caused by missing `--allow-read` permission — the tests use `Deno.readTextFileSync()` to grep source files for re-duplicated functions, and without read permission they throw `PermissionDenied`.

This PR adds a `deno.json` at repo root defining `deno task test` with the correct flags (`--allow-read --allow-net --allow-env`). No code logic changes.

**Verification:**
- Full suite: 1603 passed, 0 failed
- Guards proven load-bearing: deliberately re-introducing a local `resolveSymbol` in bot-scanner causes the guard to fail; removing it restores the pass
