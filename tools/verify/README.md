# Verify Dolly

The [verify skill](../../.agents/skills/verify/SKILL.md) governs verification of
Dolly itself, not workloads that Dolly runs.

## Static baseline

```sh
pnpm verify
```

Runs repository formatting and lint checks, root, infrastructure and frontend
typechecks, then the Node config guards (`pnpm test:node`: `node --test
scripts/*.test.mjs infra/*.test.ts`, exactly what CI's `node` suite runs). No Vitest
suites, browser sessions, builds or deployments are included. Unlike `pnpm check`,
this does not run frontend unit tests.

## Local dev server

`pnpm dev` serves the Worker and web app on `127.0.0.1:8787` with the production
configuration, so it builds the sandbox and Claude Code container images and needs
Docker. In a Dolly sandbox (no Docker, no route to Cloudflare's `Request.cf`
endpoint) run `pnpm dev:sandbox` instead, for example as the `preview` command on
port 8787: it uses the test Worker configuration (`test/worker/vite.config.ts`),
which drops the containers and enables the local Access bypass, and binds
`0.0.0.0`, so it also sets `X_LOCAL_EXPLORER=false`: the Cloudflare plugin's Local
Explorer (`/cdn-cgi/local/explorer`, on by default) sits outside Dolly's auth and
can read Durable Object storage. Both scripts set `CLOUDFLARE_CF_FETCH_ENABLED=false`,
since Dolly never reads `request.cf`. Signed-in pages still need seeded storage and a session cookie.

If the dev server fails with `ReferenceError: module is not defined`, delete
`node_modules/.vite`: an optimizer cache from a run that could not resolve React
(before `publicHoistPattern` in `pnpm-workspace.yaml` hoisted web's React to the
root) is reused otherwise.

## Worker test setup

Worker suites under `test/` share one Miniflare instance per file, so storage
outlives a test unless it is cleared. Start each test with `resetStorage()` from
`test/storage.ts`, not `reset()` from `cloudflare:test`: `reset()` clears only
Durable Objects that are live, and an object stopped by `abortAllDurableObjects()`
(as `afterEach` hooks do) keeps its key-value storage and Pi's SQLite tables
(documents, document revisions, conversations), so automations, review receipts
and GitHub threads would carry into the next test. `resetStorage()` wakes every
object first. Call it before spying on `Harness.open`: waking an Agent opens its
harness.

A Durable Object RPC that rejects is logged by workerd as `uncaught exception;
source = Uncaught (in promise)` even when the caller handles it. Expected outcomes
crossing the Sandbox RPC (a cancelled command, a failed prepare) are returned as
values for that reason; a test that wants a rejection without the log can call the
method inside `runInDurableObject`. A genuinely unhandled rejection in the test
isolate is different: Vitest reports it as an error and fails the run.

## Integration-first behavioral proof

Prefer integration tests for roughly 90% of behavioral coverage, with a small
critical-path end-to-end layer. This is not a test-count target. Unit tests are
outside this workflow; existing suites and CI remain unchanged.

| Changed boundary                                                           | Command                        | What it proves and does not prove                                                                                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built Worker HTTP/SSR, assets, API routing, Worker-side Access enforcement | `pnpm test:integration:worker` | Real bundled requests in local workerd/Miniflare, with test bindings and controlled authentication fixtures; not deployed Access edge policy, live inference or real containers.   |
| Sandbox checkout, Git, turn-end recovery and dependency caching            | `pnpm test:sandbox`            | Existing container integration scenarios using Docker and local test services; not live GitHub App authorization or deployed snapshot lifecycle proof.                             |
| Browser interactions                                                       | `pnpm test:worker`             | Worker integration suites plus CDP browser tests against the test Worker. Browser tests intercept API/WebSocket traffic; their success does not prove backend operations complete. |
| Production packaging, bindings and ingress                                 | `pnpm build`                   | Builds and deployment dry runs, including the sandbox image. Requires Docker; does not deploy or prove live runtime behavior.                                                      |

Choose scenarios for the changed behavior and its load-bearing neighbors. A passing
default suite does not prove a path it never exercises. Add or extend integration
tests when coverage is missing, preserving real boundaries rather than mocking the
implementation under test.

For focused built Worker checks, build once, then select a scenario:

```sh
pnpm exec vp -C . build --config test/worker/vite.config.ts
pnpm exec vp test run --config vitest.worker.config.ts -t 'keeps API authentication'
WEB_TEST_ACCESS=required pnpm exec vp test run --config vitest.worker.config.ts
```

The Access-required configuration selects a different test file; passing the
default HTTP suite alone does not exercise it. Rebuild whenever build inputs change.

Container scenarios can also be selected:

```sh
pnpm test:sandbox -t 'scenario name'
```

For a focused fixture-backed browser interaction after building the test Worker, with a
browser container, Cloudflare Browser Run (`BROWSER_CDP_URL=wss://…` plus `BROWSER_CDP_TOKEN`)
or a local Chrome (`BROWSER_EXECUTABLE`); see `web/e2e/browser/setup.ts`:

```sh
BROWSER_CDP_URL=http://127.0.0.1:9222 pnpm --dir web test:e2e e2e/session-list.spec.ts
```

Do not substitute `pnpm test` or `pnpm check:web` for integration proof: those
commands include unit suites. No broad test command is required by this workflow.

## Real end-to-end verification

A genuine system journey would use an authenticated deployed Dolly, create an
isolated session, submit a task, observe real model inference and sandbox execution,
and inspect the resulting files or Git side effects. The current fixture-backed
browser suite does not do this.

Live journeys require explicit authorization for the environment, credentials,
subscription usage, mutations and cleanup. Do not automatically deploy, change
Access settings, consume inference, push Git changes or create live resources.
Never print credentials. Keep local Access bypasses out of production.

Both Worker test commands leave test build artifacts with `ACCESS_LOCAL_DEV=true`
and substituted bindings. Never deploy that output. Rebuild the intended production
configuration immediately before any separately authorized deployment.

## Evidence and reporting

Record:

- Changed behavior, exercised scenarios, commands and observed results.
- Which boundaries were real, locally simulated, fixture-backed or mocked.
- Relevant side effects and desktop/phone before/after screenshots or an interaction recording for visible UI changes. These must be embedded in the PR description, not just captured: upload with `github` `upload_screenshot`, then add the returned images to the body with `update_pull_request`. See the verify skill.
- Failed, skipped or unavailable scenarios and remaining live-system gaps.

Preserve evidence after cleaning up only owned test resources. Never report an
unexercised path as passing or call fixture-backed browser coverage system e2e.
Reuse evidence only while its relevant inputs remain unchanged.
