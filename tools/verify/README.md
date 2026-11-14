# Verify Dolly

The [verify skill](../../.agents/skills/verify/SKILL.md) governs verification of
Dolly itself, not workloads that Dolly runs.

## Static baseline

```sh
pnpm verify
```

Runs repository formatting and lint checks, then root, infrastructure and frontend
typechecks. No unit tests, integration tests, browser sessions, builds or deployments
are included. Unlike `pnpm check`, this does not run frontend unit tests.

## Integration-first behavioral proof

Prefer integration tests for roughly 90% of behavioral coverage, with a small
critical-path end-to-end layer. This is not a test-count target. Unit tests are
outside this workflow; existing suites and CI remain unchanged.

| Changed boundary                                                           | Command                        | What it proves and does not prove                                                                                                                                                |
| -------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built Worker HTTP/SSR, assets, API routing, Worker-side Access enforcement | `pnpm test:integration:worker` | Real bundled requests in local workerd/Miniflare, with test bindings and controlled authentication fixtures; not deployed Access edge policy, live inference or real containers. |
| Sandbox checkout, Git, turn-end recovery and dependency caching            | `pnpm test:sandbox`            | Existing container integration scenarios using Docker and local test services; not live GitHub App authorization or deployed snapshot lifecycle proof.                           |
| Browser interactions                                                       | `pnpm test:worker`             | Worker integration suites plus Playwright against the test Worker. Browser tests intercept API/WebSocket traffic; their success does not prove backend operations complete.      |
| Production packaging, bindings and ingress                                 | `pnpm build`                   | Builds and deployment dry runs, including the sandbox image. Requires Docker; does not deploy or prove live runtime behavior.                                                    |

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

For a focused fixture-backed browser interaction after building the test Worker:

```sh
pnpm --dir web exec playwright test --config playwright.worker.config.ts e2e/session-list.spec.ts
```

Do not substitute `pnpm test` or `pnpm check:web` for integration proof: those
commands include unit suites. No broad test command is required by this workflow.

## Real end-to-end verification

A genuine system journey would use an authenticated deployed Dolly, create an
isolated session, submit a task, observe real model inference and sandbox execution,
and inspect the resulting files or Git side effects. The current fixture-backed
Playwright suite does not do this.

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
- Relevant side effects and desktop/phone before/after screenshots or an interaction recording for visible UI changes.
- Failed, skipped or unavailable scenarios and remaining live-system gaps.

Preserve evidence after cleaning up only owned test resources. Never report an
unexercised path as passing or call fixture-backed browser coverage system e2e.
Reuse evidence only while its relevant inputs remain unchanged.
