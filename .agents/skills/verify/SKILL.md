---
name: verify
description: Verify Dolly changes with static checks and integration-first proof. Use when changing this repository, choosing verification, or opening/updating a PR (UI PRs need before/after screenshots in the PR description); not for workloads Dolly runs.
---

# Verify Dolly changes

## Non-negotiable: fix everything verification flags

**Every problem verification reports must be fixed before you proceed: before committing, pushing, opening or updating a PR, or reporting the work as done.** That covers lint errors, type errors, failing tests, broken builds and missing required evidence such as screenshots.

- **It does not matter who caused it.** Pre-existing failures, failures inherited from `main`, failures from a merge and failures in files your change never touched all count. "Not my error", "unrelated" and "already broken on main" are never reasons to leave something broken. We all work toward the same goal: a green repository.
- **Reporting a failure does not resolve it.** Listing it in a PR description, a summary or a "known issues" note is not a substitute for fixing it.
- **Do not suppress problems to pass.** Disabling lint rules, adding `@ts-ignore` or `as any`, skipping tests or weakening assertions are not fixes unless the check is genuinely wrong. If it is, say why in the change.
- **Stop only when you are truly blocked.** If a fix needs access, credentials, network hosts or a product decision you don't have, stop and tell the user exactly what is blocked and what you need. Do not quietly continue past the failure.
- **Fix it in the current branch.** If the fix is large, ask the user whether it should go in a separate PR first; until they answer, the work is not done.

## Non-negotiable: a UI PR is not open until its screenshots are in its description

**If a PR changes anything visible in `web/`, opening it includes embedding desktop and phone before/after screenshots in the PR description, in the same turn.** Taking screenshots and leaving them in your own conversation does not count: reviewers cannot see them.

- **This is the maintainer's standing request for PR screenshots.** The `github` tool only publishes screenshots "when the user has requested PR screenshots/evidence". For this repository, the request is already made, by this rule, for every PR with a visible UI change. Do not wait to be asked.
- **How:**
  1. Capture with `preview` `screenshot`. It returns an `r2://screenshots/...` reference.
  2. Open the PR, then call `github` `upload_screenshot` once per image with the repository, PR number, that reference and a caption like `Before — desktop 1440×900`. Keep the `image_url` and `markdown` it returns. The upload succeeds even if its comment fails (`comment_url` is `null`), and the URL is still usable.
  3. Call `github` `read_pull_request`, then `update_pull_request` with the **whole** existing body plus a `## Screenshots` section. Lay the images out as a table, with rows for desktop and phone (and any extra states) and columns for Before and After, using the returned markdown. `body` replaces the description, so never send only the new section.
- **The tool also posts a comment.** `upload_screenshot` always adds one comment per image, and there is no tool to delete comments. The description is the record reviewers read; mention in your reply that the comments can be deleted.
- **The minimum set:** before and after at desktop (1440×900) and phone (390×844), plus any other state the change introduces, such as open/closed, overlay or empty. Capture "before" from `main` before you change anything, or by stashing your change and rebuilding.
- **Only upload screenshots of the final code.** If you change the UI after capturing, capture again. Look at every image first: no broken layouts, stale builds, secrets or private data. Use fixture data, not real accounts.
- **If you can't capture or upload, you are blocked.** Say so to the user and in the PR body, and don't describe the PR as finished.
- **Before you report the PR as done,** read the PR back with `github` `read_pull_request` and confirm the description has the `## Screenshots` table, with every image URL in it and the rest of the body intact.

1. Name the changed behavior, affected callers and observable pass condition. Reproduce a bug through the affected boundary before fixing it; establish a known-good baseline for a refactor.
2. Run `pnpm verify` for formatting, lint and root/infra/web typechecks. It does not run tests, build, deploy or contact live product services. Inspect the diff after any generation commands. `pnpm check` is not the static-only equivalent: it also runs frontend unit tests.
3. Prove changed behavior primarily with integration tests through real boundaries: HTTP handlers, Durable Objects/storage, built Worker routing, containers, Git, turn-end checkpoint recovery and dependency caching. Choose the affected scenarios and relevant failure cases; widen coverage for shared contracts. Add or extend integration coverage when the existing harness does not exercise the change.
4. Use a small number of browser or live end-to-end journeys for critical behavior that needs them. Existing browser tests (`web/e2e`, driven over CDP) intercept API/WebSocket traffic: they prove browser interactions against fixtures, not real backend operations. Static checks and mocked internal behavior are not integration proof.
5. Record the scenario, commands, observed output and side effects. State which boundaries were real, simulated or mocked. For visible UI changes, capture desktop and phone before/after screenshots or an interaction recording; this is required, not optional, and a broken screenshot tool is a blocker to report, not a step to skip. Preserve evidence and clean up only resources the run created.
6. Report results and gaps in the PR. For visible UI changes, embed the screenshots in the PR description as soon as it is open (see "A UI PR is not open until its screenshots are in its description" above). Failed, skipped, unavailable or unexercised scenarios are unverified, not passes. Fix every failure, including pre-existing and inherited ones (see the non-negotiable rule above). Never claim live-system proof from local or fixture-backed tests.

## Coverage policy

Static checks are the baseline. Roughly 90% of behavioral coverage should come from integration tests, with a small end-to-end layer; this is a design preference, not a test-count quota. Unit tests are not part of this verification workflow. Do not add unit tests or run unit suites merely to satisfy a verification checklist. Existing unit suites and CI remain unchanged.

Verification follows the diff, not a mandatory final full-repository run. Reuse evidence while its inputs remain unchanged. Use the existing harnesses before adding infrastructure; do not replace a real boundary with a mock just to make a test pass.

## Commands and safety

- `pnpm test:integration:worker`: build the test Worker and exercise real bundled HTTP/SSR routing and Worker-side Access enforcement, without a browser.
- `pnpm test:sandbox`: exercise container, Git, turn-end checkpoint recovery and dependency-cache integration paths; requires Docker.
- `pnpm test:worker`: Worker integration checks followed by fixture-backed browser tests. It is not a live end-to-end suite.
- `pnpm build`: production packaging and deployment dry runs, including ingress and the sandbox image; not a deployment.

Local workerd/Miniflare is not deployed Cloudflare. Live Access edge policy, provider inference and Browser Run connectivity need explicitly authorized live verification. Never deploy, change Access infrastructure, use real subscription inference or mutate live resources merely to complete verification. Use isolated test resources and agreed cleanup.

`test:integration:worker` and `test:worker` leave test build artifacts with a local Access bypass and substituted bindings. Never deploy those artifacts; rebuild the intended production configuration immediately before deployment.

Read [the verification reference](../../../tools/verify/README.md) for coverage boundaries and focused commands. This skill is repository development guidance only: do not install it into Dolly's runtime prompts, tools or workload repositories.
