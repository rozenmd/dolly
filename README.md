# pi-hard

A Cloudflare Access-protected personal coding-agent API on Cloudflare Workers, using Hono, Effect 4.0.0-rc.112, Pi Durable 1.5.2, Cloudflare Sandbox 1.0.3, and a ChatGPT/Codex subscription. No OpenAI API key is required.

## Web frontend

The `web/` workspace is a TanStack Start + React frontend with a dark, responsive workspace sidebar, searchable sessions, an activity feed, Markdown conversations, tool output, and a message composer.

The app is served at the Worker's `/`, with the existing Hono endpoints under `/api/*` on the same origin. `/api/health` remains available without credentials. Cloudflare Access protects the page and its assets; Agent API calls additionally require the existing bearer token; browser setup routes under `/api/setup/github/*` require Access without a bearer token.

```sh
pnpm install --frozen-lockfile
# Set ACCESS_LOCAL_DEV=true in .dev.vars for local development only.
pnpm dev
```

Open `http://localhost:8787`. Docker and `.dev.vars` are required. It starts in a labeled preview with example content; preview actions never submit work to the agent. To use real sessions:

1. Connect the local Worker's Codex subscription using the login instructions below, and connect GitHub if you want repository checkouts.
2. Choose **Connect your API** and enter the existing `API_TOKEN` from `.dev.vars`. Requests go directly to the same Worker's `/api`; the frontend does not inject credentials or bypass bearer authentication.
3. Create a workspace with an optional `owner/repository`, or open a known session ID. Send a task; the frontend polls the recent transcript and live progress every 2.5 seconds. **Stop agent** aborts the selected session and its descendants.

The token stays in memory and must be entered again after reloading. Only session IDs, titles, repository labels, models, and update times are saved in local storage. There is no server session-list endpoint yet, so the activity feed lists only sessions created or imported in this browser, not all sessions on the Worker. Imported sessions use manually entered display labels. Repository sessions use the server's restricted default network policy; the UI does not grant dependency network hosts.

```sh
pnpm check
pnpm test
pnpm --dir web exec playwright install chromium
pnpm test:worker
pnpm build   # deployment dry runs, including the frontend and sandbox image
pnpm deploy  # publish the combined Worker and frontend
```

The root Vite configuration uses the Cloudflare adapter to bundle the TanStack Start server, the Hono API, Durable Objects, and frontend assets into one Worker build. `pnpm build` and `pnpm deploy` include the UI; no separate frontend host or production proxy is needed. `pnpm dev:web` and `pnpm build:web` remain available for frontend-only development, with the development server on port 3000 proxying `/api` to the Worker on port 8787.

Protect the **entire hostname** with Cloudflare Access, preserving the Worker's JWT and bearer-token checks. A browser's Access cookie supplies the JWT through Cloudflare; never put Access service credentials or `API_TOKEN` in a `VITE_*` variable or a client bundle. `ACCESS_LOCAL_DEV` must remain false in production. The HTTP/browser test build disables containers and uses local storage simulation; the production build and sandbox integration tests retain real containers.

## Deploy to Cloudflare

Use Node.js 24.22.2 and pnpm 12.18.0 (pinned in `.node-version` and `package.json`), a running Docker engine to build the container image, and a paid Cloudflare Workers account with Artifacts enabled. Create a private Artifacts namespace named `pi-hard-workspaces`; the typed configuration binds it as `WORKSPACES`. The image builds a pinned ArtifactFS driver and includes FUSE.

Install pnpm using the [official instructions](https://pnpm.io/installation). With Node.js already installed:

```sh
npm install --global pnpm@12.18.0
pnpm install --frozen-lockfile
pnpm exec cf auth login
```

For first-time setup, create a private secrets file and generate an API token:

```sh
cp .dev.vars.example .dev.vars
openssl rand -hex 32
```

Save the generated value as `API_TOKEN` in `.dev.vars`. Keep that file private. If you already have a configured `.dev.vars`, reuse it instead of copying the example or generating another token.

```sh
# First deployment only: upload the configured API token.
pnpm run deploy --secrets-file .dev.vars
```

### Require Cloudflare Access

The first deployment refuses API calls until Access is configured. Before connecting Codex:

1. In Cloudflare, enable [Access protection for this Worker's production `workers.dev` URL](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/#manage-access-to-workersdev). Protect the entire hostname, not just one API path. In Zero Trust, restrict the application's Allow policy to your identity or approved users; do not use an Everyone or Bypass policy.
2. For the login script and `curl`, create or reuse an Access service token. Add a **Service Auth** policy to this application that includes only that token. A service token is a machine credential, separate from your Codex subscription and the Worker's `API_TOKEN`.
3. Copy the Access application's audience (AUD) tag and your team domain into `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` in `cloudflare.config.ts`. The team domain is a hostname such as `your-team.cloudflareaccess.com`, without `https://` or a path. Keep `ACCESS_LOCAL_DEV` set to `"false"` for deployments.
4. Redeploy with `pnpm run deploy`. The Worker verifies the Access JWT's RS256 signature, issuer, audience and expiration on every `/api/*` request, in addition to requiring `API_TOKEN`. Missing configuration, missing/forged tokens and failed certificate lookups cannot authorize API access.

Preview URLs are disabled in the configuration. If you add a custom domain, protect that entire hostname with Access too, and either protect or disable the alternate `workers.dev` route (`workersDev: false`). Never leave an alternate public hostname or preview unprotected. The Worker-side JWT check also prevents those routes from accepting requests with only the API token.

Save your approved service token in a separate local file:

```sh
# Only create this file if it does not already exist.
test -f .env.access || cp .env.access.example .env.access
```

Fill in `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in `.env.access`. It is ignored by Git and loaded by `pnpm run login`. Do not upload this file with `--secrets-file`: these credentials belong to your client, not the Worker. Keep existing service credentials instead of creating a new token for each deployment.

Set `API_URL` to the Access-protected HTTPS Worker URL printed by deployment, then connect your Codex subscription:

```sh
export API_URL=https://pi-hard.your-subdomain.workers.dev
pnpm run login
```

The login client reads `API_TOKEN` from `.dev.vars` and the Access service credentials from `.env.access`, then connects to the deployed Worker. Open the printed OpenAI URL and enter the one-time code. Enable device-code authentication in your ChatGPT security settings if OpenAI requires it. The client polls until connected. Access depends on your subscription's Codex entitlement and usage limits.

This creates a fresh login for this Worker. Do not copy an existing Codex `auth.json` or share a refresh token with another process. OpenAI rotates refresh tokens, and two independent refresh owners can invalidate each other's login.

For later deployments, run `pnpm run deploy` without `--secrets-file` to preserve the deployed secret. The deployed secret and the `API_TOKEN` used by the login client must match. No deployment is performed by the test or build commands.

`cloudflare.config.ts` owns Worker bindings, SQLite Durable Object exports, observability, and the Sandbox container definition. The pinned `cf` CLI loads it for development and deployment; Wrangler remains only its underlying bundler, with no hand-maintained Wrangler configuration file. Cloudflare's programmatic configuration is currently in open beta.

`CODEX_MODEL` in `cloudflare.config.ts` selects the default model for new conversations; a session request's `model` overrides it. It must be present in the pinned Pi Codex provider catalog and available to your subscription. Requests use the subscription-backed Codex Responses endpoint over SSE, not the billed OpenAI API endpoint.

## Connect GitHub

GitHub authentication runs in the Worker. Each coding conversation can clone GitHub.com repositories accessible to the connected App installations whose user or organization is in your account allowlist. Containers never receive App keys or installation tokens.

After deployment and Access setup, load your existing client credentials as shown below, then request a setup link:

```sh
curl -sS "$API_URL/api/integrations/github/setup" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"owner":"your-account","ownerType":"personal"}'
```

For an organization, use `"ownerType":"organization"`. Connect one App, then install it on the accounts and repositories you want to use. New Apps support installation on other accounts; if you previously created a private App, enable installation on other accounts in GitHub App settings without replacing its credentials. Open `setupUrl` in a browser signed into your Cloudflare Access application. Create the App, then open the returned `installUrl` and choose **selected repositories** or **all repositories** for each installation. GitHub controls repository access within each installation; Pi Hard separately restricts which installation accounts it will use. The browser setup and callback routes at `/api/setup/github/:state` and `/api/setup/github/callback` require Access without a bearer token; agent API operations additionally require the bearer token. No public callback bypass is needed.

Configure the allowed GitHub users and organizations through the protected API:

```sh
curl -sS -X PUT "$API_URL/api/integrations/github/accounts" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"accounts":["your-account","your-organization"]}'
```

`GET /api/integrations/github/accounts` reads the list. `PUT` replaces it; names are case-insensitive. An unset or empty list denies every account, including for existing deployments until configured. The policy survives restarts and applies to repository discovery, repository tools, Git checkout/fetch/push, and webhook intake/replies. Removing an account prevents subsequent GitHub requests even when an installation token was cached. It does not uninstall the App, stop an already-running request, or erase existing checkouts. The webhook sender allowlist remains separate: allowed accounts identify repository owners, while allowed senders identify who may issue `/pi` commands. GitHub may still deliver webhooks from other installations, but Pi Hard rejects their commands before repository lookup or agent admission.

The App grant and read/write/code token permission maps match [Open Session's public permission definitions](https://github.com/tellahq/opensession/blob/main/packages/core/opensession-server/src/shared/github-app-permissions.ts), retained in `src/github-permissions.ts`. The grant includes Actions, Checks, Contents, Pull requests, Issues and Deployments write, plus Statuses, Members and Metadata read. Installation tokens are narrowed by operation and repository. Existing Apps must accept these permission updates in GitHub settings; no replacement App key is needed. This grants no Administration or Workflows permission. The copied definitions retain their MIT notice in `third_party/opensession/LICENSE`.

Setup links expire after one hour and survive Worker eviction. Repeating setup preserves an existing connection and returns its installation link without asking for credentials again. A consumed callback cannot be replayed. If conversion fails, request a fresh setup link; if GitHub created an unused App, remove it in GitHub settings before creating another. App private keys remain in Durable Object storage. The webhook signing secret stays server-side; unused OAuth credentials are discarded, and short-lived installation tokens stay in Worker memory.

New agent sessions have a `github` tool. It discovers repositories across App installations, reads UTF-8 files up to 32 KiB, creates `pi-hard/*` branches, writes files up to 32 KiB with an expected file SHA, and opens pull requests. It cannot merge, write the default branch, or edit `.github/workflows/`. Use a new path without `sha` only when creating a file. Mutations are not automatically replayed after interruption; inspect GitHub before retrying an uncertain write.

The same operations are available through `POST /api/integrations/github/execute`, with an `operation` object. For example:

```json
{
  "operation": {
    "action": "read_file",
    "repository": "your-account/your-repo",
    "path": "README.md",
    "ref": "main"
  }
}
```

Other actions are `repositories`, `create_branch`, `write_file`, and `open_pull_request`; their shared contracts are in `src/github-contracts.ts`. `GET /api/integrations/github` returns connection metadata and the installation link, never credentials. Provider requests reject redirects, time out after 15 seconds, and cap response bodies at 1 MiB.

Pushes authenticate as the App installation, not the person who installed it. Local commit author metadata is configured as Pi Hard. With this repository's `rozenmd`-only CI policy, App-authored pushes do not start CI. Connected-user authorization is not included.

### Work on a repository

Create a conversation with a repository and optional ref. The App owner does not have to own the repository:

```json
{
  "workspace": {
    "repository": "another-owner/project",
    "ref": "main",
    "networkHosts": ["registry.npmjs.org"]
  }
}
```

Send that JSON to `POST /api/sessions` with the normal API authentication, then submit a task through its messages route. The agent has a `workspace` tool to check out, inspect status/diff, commit, push, and open a PR. Its `shell` tool runs in `/workspace/repo`, with Git, Node.js, Corepack, Python 3, curl and CA certificates installed. Use shell commands for edits and the repository's test suite. Other toolchains can be installed through hosts explicitly enabled for the session; not every repository uses the image's built-in tools.

You can also create a blank conversation and let the agent select a repository using `workspace` with `{"action":"checkout","repository":"another-owner/project","ref":"main"}`. Dependency network hosts are supplied by the API client when creating a repository session, not granted by the model. An omitted host list permits only brokered Git traffic. The HTTPS intercept trusts the Containers CA through the provided certificate environment settings; tools with their own certificate store may need configuration.

Each conversation owns one checkout and a `pi-hard/session-<conversation-id>` branch. Repository selection cannot be changed in place. Children inherit the repository/ref and network policy but get separate checkouts and branches. PR webhook conversations start at `refs/pull/<number>/head` and push their own branch, not the original PR branch.

For direct control, `POST /api/sessions/:id/workspace` accepts the same actions:

```json
{"action":"status"}
{"action":"diff"}
{"action":"commit","message":"Fix the failing test"}
{"action":"push"}
{"action":"open_pull_request","title":"Fix the failing test","body":"Tests passed"}
```

Commit and push are separate, explicit operations. Opening a PR targets the repository's default branch. Pushing uses ordinary Git fast-forward checks; failed writes are not automatically retried. The App does not request workflow-writing permission, so GitHub may reject pushes changing workflows. No merge operation is provided.

Workspaces use ArtifactFS for named Git refs. It mounts a blobless checkout and hydrates file contents on demand. Unadvertised commit IDs use an ordinary exact-revision checkout because ArtifactFS requires a named source ref. Direct network access stays disabled; both GitHub and Artifacts traffic pass through private Worker brokers. Repository-scoped credentials are minted and used only in the Worker.

After foreground commands, a separate Artifacts repository records a checkpoint. Working files are a versioned Git tree, while Git metadata is stored separately so restoring a checkpoint preserves the user's HEAD, staged changes, reflogs, and uncommitted files. Checkpoint commits never enter the user's GitHub branch. Each checkpoint has an immutable ref; the Durable Object acknowledges it only after a successful push. A failed push or lost acknowledgement cannot replace the last acknowledged checkpoint.

Checkpoints retain ignored files, dependencies, nested Git metadata, symlinks, and empty directories. This preserves recovery behavior but requires scanning the full workspace after commands, which hydrates unread source files on the first checkpoint. Large dependency trees still increase checkpoint time and storage. Stop background writers before commands complete; checkpoints do not freeze concurrent processes. Checkpoint history and Durable Object storage remain private and grow with usage.

Container replacement mounts the last acknowledged Artifacts checkpoint through ArtifactFS and restores the user's Git metadata without replaying commands. The Linux runtime must expose `/dev/fuse` and permit FUSE mounting by the unprivileged container user. The container integration test requires an actual mount and covers edits, commit/push, staged and ignored-file recovery, and recovery after checkpoint publication fails. On Linux, use rootless Docker with `/dev/fuse` available; Miniflare intentionally does not grant FUSE privileges to rootful Linux Docker. The test command configures a rootless daemon on GitHub Actions runners, without changing the trusted actor gate.

This replaces the earlier R2 checkpoint format. Existing R2 checkpoints fail closed rather than silently starting with an empty checkout. If you deployed the earlier implementation, export or migrate those workspaces before switching; this change does not delete the old bucket.

### Receive GitHub PR commands

The public webhook Worker is separate from the Access-protected API. Its only route is `POST /hooks/github`. It holds no credentials and calls the main Worker's named `GitHubIngress` entrypoint through a private service binding. The main hostname has no public webhook route.

1. Deploy the updated main Worker with `pnpm run deploy`, preserving existing credentials. Then deploy the public receiver with `pnpm --dir ingress exec cf deploy`. Keep the main hostname protected by Access; the separate ingress hostname must accept GitHub requests without Access. Preview URLs remain disabled for both Workers.
2. Set `GITHUB_WEBHOOK_URL` in `cloudflare.config.ts` to the ingress Worker's HTTPS URL ending in `/hooks/github`, then redeploy the main Worker. Do not put webhook secrets in configuration files or the public receiver.
3. For a new GitHub App, the setup manifest enables the `issue_comment` event and the public webhook URL. For an existing App, update its webhook URL in GitHub App settings, enable webhooks, grant **Issues: Read-only**, and subscribe to **Issue comments**. Approve the updated permissions for the existing installation. Keep the existing App key and installation. If this deployment predates webhook-secret storage, set a new random secret of at least 32 characters in GitHub's webhook settings and supply that same secret once when configuring intake.
4. Install the App on the repositories you want to use and connect Codex before enabling command intake. Configure the allowed GitHub users through the protected API:

```sh
curl -sS -X PUT "$API_URL/api/integrations/github/webhook" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"senders":["your-github-login"]}'
```

Only add `"secret":"your-webhook-secret"` to that JSON when no signing secret is stored yet, or when deliberately rotating it. Existing App credentials and an already-configured signing secret are preserved. Configuration checks the App event subscription and permission. Every command checks the current repository installation against the signed installation ID; new grants and reinstalls do not require rebuilding a Pi Hard repository list.

An allowed user can post `/pi Read README.md and explain the project` as a new comment on a PR in a repository available to an App installation. The command must start the comment. Issue comments without a PR, edits, bot comments, other events, and comments without `/pi` do not trigger agents. Repository, installation, and both comment-author and sender identity are checked after HMAC-SHA256 verification over the exact request bytes.

Intake stores the conversation mapping, comment-ID receipt, and Pi delivery task together before returning `202`. It uses the signed comment ID rather than trusting the unsigned delivery header. Repeated deliveries resume the same task; additional commands on the same PR use the same conversation. Pi owns restart recovery and reply retries. Replies check the App bot's existing comment marker before posting, including after a lost response. GitHub comment visibility and deletion prevent a strict exactly-once guarantee.

`GET /api/integrations/github/threads`, with the normal API authentication, lists conversation IDs and delivery status/outcomes. Open a conversation through the existing session API or abort it with the existing session abort route. Reply failures retain a failed task outcome after five attempts and diagnostic details in Worker logs.

Payloads are capped at 256 KiB and command text at 16,384 characters. There are no application-imposed counts for repositories, allowed senders, PR threads, or commands per thread. Deduplication receipts are retained; storage grows with usage. Unconfigured intake or a missing Codex connection returns `503`; invalid signatures return `401` and disallowed identities/repositories/installations return `403`. GitHub does not automatically retry failed deliveries: use **Redeliver** in the App's recent deliveries after fixing configuration or availability. An accepted task remains durable even if GitHub misses the acknowledgement.

## Use the API

Use the Access-protected deployed `API_URL`, your approved Access service token, and the same private bearer token configured on the Worker. Both authentication checks are required.

```sh
# Load existing client credentials; do not generate new ones.
. ./.dev.vars
. ./.env.access
export API_TOKEN CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET

curl -sS "$API_URL/api/sessions" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-6-sol"}'
```

The response includes `id` and the selected `model`. The optional `model` must be in Pi's pinned Codex catalog; unknown models return `400`. For example, `gpt-6-luna`, `gpt-6-sol`, and `gpt-6.1-terra` are supported by this version. Your subscription must also allow the selected model. An empty body or `{}` uses `CODEX_MODEL` from `cloudflare.config.ts`. Selection is saved with the conversation, survives restarts, and does not change other sessions.

Use the returned `id`:

```sh
export SESSION_ID=the-returned-id
curl -sS "$API_URL/api/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H 'Content-Type: application/json' \
  -d "{\"content\":\"Write hello.js in /workspace and run it\",\"requestId\":\"$(uuidgen)\"}"

curl -sS "$API_URL/api/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

A prompt returns `202` after durable admission, not after generation. Poll the session to read its Pi conversation view, including recent entries and live progress. Reuse the same UUID `requestId` when retrying the same prompt to avoid duplicate work. The snapshot contains a bounded recent transcript window, not an export of all history.

| Route                             | Operation                                                    |
| --------------------------------- | ------------------------------------------------------------ |
| `GET /api/health`                 | Liveness check (Access still protects the deployed hostname) |
| `POST /api/auth/codex`            | Start or reuse device login                                  |
| `GET /api/auth/codex`             | Poll login, respecting `pollAfterSeconds`                    |
| `DELETE /api/auth/codex`          | Delete the Worker's local credentials and pending login      |
| `POST /api/sessions`              | Create a conversation                                        |
| `GET /api/sessions/:id`           | Read the latest conversation view                            |
| `POST /api/sessions/:id/messages` | Submit `{content, requestId}`                                |
| `POST /api/sessions/:id/abort`    | Abort current and queued work                                |

Logout does not revoke the grant at OpenAI or cancel an already-authorized model request. Abort active sessions before disconnecting if you need work to stop.

## Child agents

Agents can delegate through `spawn_task`, `send_to_session`, `list_children`, `task_status`, `wait_for_task`, and `cancel_task`. Children have their own conversation and sandbox; they receive only the supplied prompt, not a copy of the parent's transcript or files. The child inherits its parent's model unless an optional `model` selects another model from the Codex catalog.

```text
Parent session
  | spawn_task({ content, model? })
  +-- Child session + separate sandbox
  |     +-- Grandchild session + separate sandbox
  |
  | wait_for_task({ taskId })
  <--- Answer or failure receipt
```

Spawning and sending return immediately. Each returns a `taskId` for that message's answer. `wait_for_task` waits for the receipt; `task_status` checks without waiting. There is no automatic follow-up turn when a child finishes: the parent must explicitly wait or check. Child creation, message delivery and results survive Durable Object restarts, using Pi's durable tasks and ownership edges. Interrupted model requests may be retried; prompts and child creation are deduplicated.

The server enforces these limits, including for API clients:

- Three child levels below a root (root depth is zero).
- Eight children per session over its lifetime, not just eight running at once.
- 32 child-message deliveries per session, including each child's initial prompt.
- Child answers in task receipts retain the first 16,384 characters; read the child's transcript for its recent full answer.

These bound delegation but are not a spending limit. All sessions share your subscription's usage allowance. Creating another root starts a new set of limits.

The same operations are available over authenticated HTTP:

| Route                                               | Operation                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `POST /api/sessions/:id/children`                   | Spawn with `{content, requestId, model?}`; returns `202` with `{id, model, taskId}` |
| `GET /api/sessions/:id/children`                    | List direct children                                                                |
| `POST /api/sessions/:id/children/:childId/messages` | Queue `{content, requestId}` for a direct child; returns `202` with `{taskId}`      |
| `GET /api/sessions/:id/tasks/:taskId`               | Poll a message's status and answer/failure receipt                                  |
| `GET /api/sessions/:childId`                        | Read the child's transcript                                                         |
| `POST /api/sessions/:childId/abort`                 | Stop that child and all descendants, including queued deliveries                    |

Treat both session and task IDs as opaque strings. HTTP `requestId` values must be UUIDs: retrying the same request returns its original receipt, while reusing it with different content or options returns `409`. Unknown models and invalid inputs return `400`; delegation limits return `409`. Agents can message, inspect and cancel only their own direct children; an approved Access client with the bearer token can access all sessions.

Aborting a parent also stops all descendants and pending deliveries. Aborting does not delete conversations or files, and a stopped child can receive new messages. New work admitted after an abort's snapshot is not part of that cancellation. Children cannot read a parent's workspace; container files remain ephemeral.

## Optional local development

To develop locally after installing dependencies and configuring `.dev.vars`, start the Worker with Docker running:

```sh
# Set ACCESS_LOCAL_DEV=true in .dev.vars for local development only.
pnpm run dev
```

The local `.dev.vars` setting bypasses JWT verification; the API bearer token is still required. `.dev.vars` is ignored by Git and is only for local development. Never enable `ACCESS_LOCAL_DEV` in deployed configuration. The automated Worker tests use the same explicit bypass except for the Access authentication tests.

In another terminal, explicitly select the local Worker and connect its Codex login:

```sh
export API_URL=http://localhost:8787
pnpm run login
```

Local and deployed Durable Object storage are separate; each environment needs its own subscription login. Use the same API examples with this local `API_URL`. Set `API_URL` back to your deployed HTTPS URL when returning to the deployed Worker.

## Effect architecture

Effect owns API workflows, schema validation, the Codex device protocol, credential serialization, timeouts, stream and process cleanup, and the login client. `Account`, `CodexProtocol`, and `AgentApi` are explicit services wired with Layers. Owned request and upstream schemas use Effect Schema, not Zod.

Hono handles HTTP routes; Cloudflare Durable Objects host sessions. They run Effects at HTTP, RPC and Pi callback boundaries. Pi still owns durable task scheduling and transcript storage; Effect fibers do not replace Pi's recovery mechanism. Credential locking uses one Effect semaphore per account object, shared with Pi's Promise-based credential adapter. Scoped finalizers stop transcript watches and cancel sandbox readers and processes.

## Ownership and limits

- One `Agent` Durable Object owns the account credentials and Pi SQLite storage. Credential writes, refresh and logout share one serialized queue. Login grants survive object restarts; alarms resume pending Pi work.
- Each conversation gets a separate `Sandbox` Durable Object and Linux container. The agent has `shell` and Sandbox 1.0 `Files`-backed `read_file` tools. Commands run as an unprivileged user.
- Subscription credentials and the API token never enter the container. Direct container internet access is disabled. Git traffic uses a private per-session Worker broker; it can read only the selected repository and push only the session branch, never the default branch or a deletion. Dependency downloads use an optional per-session HTTPS hostname list, without injected credentials.
- Conversation history and repository selection are durable. Repository workspaces, including `.git` and uncommitted files, are checkpointed to private Artifacts repositories after foreground shell commands, including failed commands. The last completed checkpoint is restored after container replacement. A crash during a command can lose changes since that checkpoint; interrupted commands are never automatically rerun. Blank sessions without a repository remain ephemeral. Containers stop after five minutes of inactivity.
- Shell calls have a 60-second deadline and keep at most 32 KiB per output stream. File reads allow 64 KiB. Runs stop after 20 tool rounds. Interrupted shell calls are marked unsafe to replay because commands may have side effects.
- This is single-owner software. Anyone allowed by your Access policy who also has `API_TOKEN` can use your subscription, run sandbox commands, and read conversations. There is no multi-user authorization, rate limiter, browser UI, or public sandbox preview.
- Worker storage holds OAuth secrets. Protect access to the Cloudflare account and local `.wrangler` data. Logs and transcript responses redact known tokens and OAuth fields while retaining diagnostic messages.

## Code quality

`pnpm-workspace.yaml` keeps a 24-hour minimum release age, with exact-version exceptions for existing dependencies published more recently. It permits dependency install scripts only for esbuild and workerd. New dependencies with unreviewed install scripts fail installation until approved or explicitly blocked.

`pnpm run check` runs oxfmt, Oxlint (warnings fail), and TypeScript, including in CI. Use `pnpm run format` to format files and `pnpm run lint:fix` for safe lint autofixes; run lint autofix before formatting.

All generic and Effect rules from [anti-slop](https://github.com/dmmulroy/anti-slop) are enabled in `oxlint.config.ts`. The plugin is vendored in `tools/oxlint/anti-slop/`, with its source revision and licenses recorded there. Vendored rules, generated output and installed agent tooling are excluded from lint and formatting. Keep `oxlint` and `@oxlint/plugins` on the same exact version when upgrading.

## Verification

```sh
pnpm run check         # oxfmt, Oxlint + anti-slop, TypeScript
pnpm test               # config, tooling, login client, workerd and Effect lifecycle tests
pnpm run test:sandbox  # Container + Files integration, requires Docker
pnpm run build         # deployment dry run including Docker image build
```

The ordinary tests stub OpenAI only. They run Hono, Durable Objects, SQLite, credential locking, Pi generation and the Codex SSE adapter in workerd, including crash recovery and duplicate prompt admission. Coordination tests exercise model-driven delegation and waiting, restart during a wait, inherited and overridden models, child-scoped messaging, recursive cancellation, depth/width/delivery limits, and unanswered child results. Effect tests cover interruption cleanup, permit release and TestClock-driven expiry. The login client runs against an authenticated loopback fixture. Container integration checks actual execution, file reads and isolation. The current Vitest plugin only prepares containers through its legacy loader, so sandbox tests generate an ignored `.sandbox-test.wrangler.json` from `cloudflare.config.ts` using Cloudflare's converter. This is test-only compatibility output, not another configuration source. Access tests generate RSA keys and verify signed JWTs against a fixture JWKS, including rejection of missing configuration, forged signatures, wrong issuers/audiences and expired tokens. The login-client fixture verifies both Access service headers without exposing them. No test uses a real subscription or creates a Cloudflare Access policy. A successful live login and model/tool round trip remain the final deployment smoke test.

## References

- [Pi Durable Cloudflare example](https://github.com/earendil-works/pi-durable-cloudflare), for Durable Object SQLite storage and alarm-driven recovery.
- [Cloudflare Sandbox SDK](https://github.com/cloudflare/sandbox-sdk), for the 1.0 Container API and `Files` integration.
- [Open Session device login](https://github.com/tellahq/opensession/blob/main/packages/core/opensession-server/src/server/codex-device-login.ts) and [refresh ownership](https://github.com/tellahq/opensession/blob/main/packages/core/opensession-server/src/server/codex-token-refresh.ts), for subscription sign-in and token rotation constraints. That server uses the Codex CLI; this Worker implements the headless device protocol and delegates refresh and model requests to Pi's Codex provider.
