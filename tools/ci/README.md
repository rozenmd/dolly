# Fast, conservative CI

The `check` status remains the only aggregate required check. Every selected job
must succeed; planner failures, cancellations and unexpected skips fail closed.
The existing actor/triggering-actor gate, read-only token and credential-free
checkout are retained. No secrets or deployments are added.

## Parallel work

Formatting, Oxlint, native root typechecking (`tsrs`), infra/web typechecking,
Node tests, frontend tests, root tests, bundled Worker/browser tests, sandbox
tests and production packaging can run independently. Production packaging no
longer waits for container tests. We already use Oxlint and a native checker:
swapping toolchains is not the first speed win.

Root and sandbox tests each run on two runners. `ci-sequencer.ts` assigns the
longest recorded files first to the lightest shard, with a fixed cold-start
allowance per file and a conservative estimate for new files. All files remain
isolated; no test assertions, timeouts or lint rules are weakened.

`timings.json` starts with durations from the November 16 runs
`43826863239` (root) and `43827818831` (sandbox). It only affects placement, never
test selection. The old monolithic cache file is split by package manager;
its initial group estimates sum its recorded individual test durations.
Every original cache assertion is retained. Each shard uploads a JSON report for 14 days. To refresh the
snapshot, download **all** root/sandbox timing artifacts from a successful full
run and run:

```sh
node scripts/ci-timings.mjs path/to/ci-results-*.json
```

Review the output and replace `tools/ci/timings.json`. Timing refreshes are
deliberate, not an untrusted PR cache or an automatic commit.

## Affected PR tests

`ci-plan.mjs` resolves the actual merge base against the event's base SHA; the
checkout includes history. It includes deletions and both sides of renames.

- Frontend TypeScript changes use Vitest `--changed <merge-base>` for frontend
  unit tests, plus **all** bundled HTTP/Access/browser tests and packaging.
- Backend source changes run **all** root, sandbox and bundled tests. Worker/DO
  entrypoints injected by configuration cannot be safely selected from ordinary
  imports.
- Root test-only changes use Vitest's import graph for the root tests.
- Container and browser test changes run their full boundary suites.
- Lockfiles, package manifests, configs, generated inputs, CSS/assets, shared
  test fixtures, scripts, infra/container code and unknown paths force a full run.
- Missing history fails safe to a full run. Only a genuinely affected graph run
  may pass with no matching tests; full runs may not.
- Pushes to `main`, merge queue and manual runs always select everything.

The existing identity gate also applies to merge queue/manual events: this
change does not authorize an additional bot or account.

## Rollout and measurement

`pull_request_target` uses the workflow on `main`. This PR's automatic checks
therefore still use the old three-job topology until merged. A manual run on the
feature ref can exercise the new topology if GitHub permits dispatch before the
workflow change reaches `main`.

Baseline after the sandbox mock fix: unit **1m33s**, Worker **1m41s**, sandbox +
serial packaging **2m37s** (`43827818831`). New hosted timing must be measured:
local results are not proof of a sub-two-minute hosted run. Cold image pulls and
runner queueing remain limits.
