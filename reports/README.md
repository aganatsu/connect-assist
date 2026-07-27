# Task Reports

Each file in this directory is the completion report for a specific task branch.

## Naming Convention

```
reports/<branch-slug>.md
```

Where `<branch-slug>` is the branch name with the `manus/` prefix removed.

Example: branch `manus/propfirm-fail-closed` → `reports/propfirm-fail-closed.md`

## Process

1. Each task branch writes its report to `reports/<slug>.md` (not root `REPORT.md`)
2. This prevents merge conflicts when multiple branches exist simultaneously
3. Reports accumulate as a durable record — they are never overwritten by later branches
4. The report is committed as the final commit on the branch before push

## Report Format

Every report follows the standard format defined in the project instructions:
- Task name and branch
- Behavior changes (explicit "none" or numbered list)
- Files modified
- Tests added
- Tests run (command output)
- Regression check
- Open questions
- Suggested PR title and description
