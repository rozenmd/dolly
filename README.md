# dolly

A coding agent in development on Cloudflare Workers, using Hono, Effect 4.0.0-rc.112, Pi Durable 1.5.2, Cloudflare Sandbox 1.0.3, and a ChatGPT/Codex subscription. No OpenAI API key is required. The implementation and authorization model are unfinished; the behavior documented below describes the current code, not a finished product contract.

## Web frontend

The `web/` workspace is a TanStack Start + React frontend with a dark, responsive workspace sidebar, searchable sessions, an activity feed, Markdown conversations, tool output, and a message composer.

The app is served at the Worker's `/`, with the Hono endpoints under `/api/*` on the same origin. `/api/health` is available without credentials. Cloudflare Access protects the whole hostname. Behind Access, you sign in with GitHub. The current authentication implementation records the first GitHub account as an owner and refuses other accounts; this is an implementation limitation, not an intended single-user product constraint. Signing in sets an HttpOnly session cookie that lasts 30 days.

The first visit walks through setup:

1. **Create the GitHub App.** Enter your GitHub username (or organization) and the URL of your deployed `dolly-ingress` Worker, then choose **Create GitHub App**. GitHub opens with every setting filled in from a manifest, including the webhook URL, and returns to dolly.
2. **Enable device flow.** In the new App's settings on GitHub, tick **Enable Device Flow**. GitHub has no manifest setting for it. If you skip this, sign-in says so and links to the settings page.
3. **Sign in with GitHub.** dolly shows a one-time code and a link to `github.com/login/device`. The first account to authorize becomes the owner.
4. **Sign in to ChatGPT.** dolly shows another code for `auth.openai.com/codex/device`. Enable device-code authentication in your ChatGPT security settings if OpenAI requires it.
5. **Enroll repositories.** In **Settings** (the D menu), use **Add repositories** to install the App, and list the GitHub accounts dolly can work in. Then refresh the repository picker and **Enroll** the repositories you want to use. The picker also appears when creating a workspace. No repositories are available until the account list is set.

The **+** buttons open a task-first **New session** composer: choose an enrolled repository (or **No repo**), write the task, pick a model and choose **Create**. No workspace-name form is required; the first line of the task becomes the session title. From an existing workspace, the composer defaults to its primary repository, ref, dependency-host policy and model, not the agent's currently active attachment. You can change the repository before creating. New repository selections use their default branch. Nothing is created until you submit. If submitting the first task fails after session creation, the session stays in the browser list and **Retry** reuses its ID and task request ID. **Open existing** still accepts a known session ID.

Mention another enrolled repository by name during a conversation and the agent can attach it and work there without replacing the primary repo. The frontend polls the recent transcript and live progress every 2.5 seconds. **Stop agent** aborts the selected session and its descendants. Each new session still has its own checkout and conversation; the composer does not share another session's uncommitted files or transcript.

The transcript displays assistant replies, provider retry/backoff status, and tasks that end without an answer. Failed requests show their error details rather than an empty response; session details show **Failed** or **Stopped** instead of **Idle**. System/context messages are not rendered as assistant replies. No model request is automatically re-submitted by the UI after failure; send another message to try again.

Only session IDs, titles, repository labels, models, and update times are saved in local storage. There is no server session-list endpoint yet, so the feed lists only sessions created or imported in this browser, not all sessions on the Worker. Repository sessions use the server's restricted default network policy; the UI does not grant dependency network hosts.

```sh
pnpm check
pnpm test
pnpm --dir web exec playwright install chromium
pnpm test:worker
pnpm build   # deployment dry runs, including the frontend and sandbox image
pnpm deploy  # publish the combined Worker and frontend
```

The root Vite configuration uses the Cloudflare adapter to bundle the TanStack Start server, the Hono API, Durable Objects, and frontend assets into one Worker build. `pnpm build` and `pnpm deploy` include the UI; no separate frontend host or production proxy is needed. `pnpm dev:web` and `pnpm build:web` remain available for frontend-only development, with the development server on port 3000 proxying `/api` to the Worker on port 8787.

Protect the **entire hostname** with Cloudflare Access, preserving the Worker's JWT check. A browser's Access cookie supplies the JWT through Cloudflare; never put Access service credentials in a `VITE_*` variable or a client bundle. `ACCESS_LOCAL_DEV` must remain false in production. The HTTP/browser test build disables containers and uses local storage simulation; the production build and sandbox integration tests retain real containers.

## Deploy to Cloudflare

### Existing deployments

The configuration now names the main Worker `dolly`, the public receiver `dolly-ingress`, the container `dolly-sandbox`, and the Artifacts namespace `dolly-workspaces`. These are deployment identities, not cosmetic labels. Deploying them does not rename or migrate existing Workers, Durable Object namespaces, credentials, conversations, or checkpoints. An automatic migration is not implemented. Back up the existing deployment and plan its data migration before running the deployment commands below; do not delete the existing resources as part of a rename.

Access inputs now use `DOLLY_ACCESS_*`, with Alchemy stack `DollyAccess` and application resource `Dolly`. Existing local environment files and state are not rewritten automatically. Migrate the previous stack/resource state with Alchemy's state tooling before planning changes, preserve the existing application and service-token IDs, and review the plan for unintended creations or replacements. Update the protected hostname and GitHub App callback/webhook URLs when moving traffic; keep ingress public and the main hostname protected.

Browser cookie names and the local session-list key now use Dolly's name, so existing browsers will need to sign in again and re-import saved conversation IDs. New workspace branches use `dolly/*`; existing stored workspace configurations are not rewritten. Webhook reply markers also use Dolly's name: do not redeliver previously accepted commands during a migration without reviewing their durable delivery state and existing replies.

### New deployments

Use Node.js 24.22.2 and pnpm 12.18.0 (pinned in `.node-version` and `package.json`), a running Docker engine to build the container image, and a paid Cloudflare Workers account with Artifacts enabled. Create a private Artifacts namespace named `dolly-workspaces`; the typed configuration binds it as `WORKSPACES`. The image builds a pinned ArtifactFS driver and includes FUSE.

Install pnpm using the [official instructions](https://pnpm.io/installation). With Node.js already installed:

```sh
npm install --global pnpm@12.18.0
pnpm install --frozen-lockfile
pnpm exec cf auth login
```

Deploy the main Worker and the public webhook receiver:

```sh
pnpm run deploy
pnpm --dir ingress run deploy
```

### Require Cloudflare Access

The first deployment refuses web and API requests until Access is configured. The Alchemy 2 stack in `infra/` manages Access independently of `cf deploy`, following Rat Stack's typed infrastructure and plan-before-deploy approach. It does not own the Workers, containers, DNS, or your account-wide Zero Trust settings.

1. Enable Zero Trust in your Cloudflare account if needed, and note its existing team domain (`your-team.cloudflareaccess.com`, without `https://` or a path). Create or reuse an Access service token; the stack only needs its **token UUID**, not its client ID or secret.
2. Configure an Alchemy authentication profile with `pnpm --dir infra exec alchemy profile create dolly`, then `pnpm --dir infra exec alchemy profile edit --profile dolly`. Select the same Cloudflare account as the Worker deployment and run `export ALCHEMY_PROFILE=dolly` for subsequent commands. The credentials need Access application/policy and identity-provider edit permissions. Keep provider credentials in the profile, not Worker bindings or committed files.
3. Create local stack inputs, then edit `infra/.env`:

   ```sh
   # Do not overwrite an existing configuration.
   test -f infra/.env || cp infra/.env.example infra/.env
   ```

   Set `DOLLY_ACCESS_HOSTNAME` to the **main Worker's production hostname**, not the ingress hostname. Set the team domain, comma-separated exact allowed email addresses, and existing service-token UUID. No wildcard users or Everyone/Bypass policies are accepted. If Access already protects this hostname, also set `DOLLY_ACCESS_APPLICATION_ID` to adopt that application and preserve its AUD. Adoption replaces its inline policies with the declared email and service-token policies: review this carefully.

4. Run checks, inspect the production plan, then explicitly deploy Access:

   ```sh
   pnpm run check
   pnpm test
   pnpm access:plan
   pnpm access:deploy
   pnpm run deploy
   ```

   The stack creates or narrowly adopts the account's one-time-PIN identity provider, and creates/adopts an application protecting the entire main hostname. It restricts browser login to the approved emails and **Service Auth** to the existing token. The public ingress is not included. Check the account, hostname, adoption, and policy changes in the plan before approving deployment. If you use a named Alchemy profile, set `ALCHEMY_PROFILE` consistently for both commands.

`access:deploy` exports resolved, validated non-secret settings to ignored `infra/access.generated.json` **only after a successful Access deployment**. The root `cloudflare.config.ts` reads that file; `pnpm run deploy` then publishes those settings. Use `pnpm access:export` to repeat the export without changing cloud resources. Missing generated settings leave the Worker unconfigured (503); malformed settings fail the build/deploy rather than silently disabling authentication. Keep `ACCESS_LOCAL_DEV` set to `"false"` in deployed configuration.

`pnpm run deploy` explicitly builds the root production Vite configuration before running `cf deploy --prebuilt`, avoiding framework autodetection in this multi-package workspace. `pnpm build` builds and dry-runs both the main Worker and ingress without deploying either. The ingress has its own Vite configuration and output directory; deploy it with `pnpm --dir ingress run deploy`.

If invoking `cf deploy --prebuilt` directly, always rebuild the intended production configuration immediately beforehand. Do not deploy output left by `pnpm run test:worker`: its test configuration enables the local Access bypass and replaces production bindings.

Alchemy is pinned separately with its compatible Effect version in `infra/package.json`; the application's Effect version is unchanged. Deployment ownership is persisted in ignored **`infra/.alchemy/`** using Alchemy's local state backend. Back this directory up securely and restore it on the deployment machine before planning. Do not run concurrent deploys, delete state, or switch state backends casually. The application and PIN identity provider are retained on destroy; no destroy shortcut is provided. Export reads the pinned Alchemy version's local stack-output format, covered by the export tests; recheck it when upgrading Alchemy. Neither plan nor tests export settings or deploy resources.

The Worker still independently verifies the Access JWT's RS256 signature, issuer, audience, and expiration, and then requires a GitHub sign-in session for the API. Missing configuration, missing/forged tokens and failed certificate lookups cannot authorize access. After deployment, confirm an anonymous browser is redirected to Access, your approved email can load the app, and an unapproved identity cannot. Check GitHub ingress remains public (it should reject unsigned webhook requests, not redirect to Access).

Preview URLs are disabled in the configuration. If you add a custom domain, protect that entire hostname with Access too, and either protect or disable the alternate `workers.dev` route (`workersDev: false`). Never leave an alternate public hostname or preview unprotected. The Worker-side JWT check also prevents those routes from accepting requests with only a session cookie.

Open the Worker's URL and follow the setup steps under [Web frontend](#web-frontend). ChatGPT sign-in creates a fresh login for this Worker. Do not copy an existing Codex `auth.json` or share a refresh token with another process. OpenAI rotates refresh tokens, and two independent refresh owners can invalidate each other's login. Access to models depends on your subscription's Codex entitlement and usage limits. No deployment is performed by the test or build commands.

`cloudflare.config.ts` owns Worker bindings, SQLite Durable Object exports, observability, and the Sandbox container definition. The pinned `cf` CLI loads it for development and deployment; Wrangler remains only its underlying bundler, with no hand-maintained Wrangler configuration file. Cloudflare's programmatic configuration is currently in open beta.

`CODEX_MODEL` in `cloudflare.config.ts` selects the default model for new conversations; a session request's `model` overrides it. It must be present in the pinned Pi Codex provider catalog and available to your subscription. Requests use the subscription-backed Codex Responses endpoint over SSE, not the billed OpenAI API endpoint.

## Connect GitHub

GitHub authentication runs in the Worker. Each coding conversation can clone GitHub.com repositories accessible to the connected App installations whose user or organization is in your account allowlist. Containers never receive App keys or installation tokens.

Create the App from the web UI's first-run setup. For an organization, choose **Organization** and enter its name. Then use **Add repositories** in **Settings** and choose **selected repositories** or **all repositories** for each installation. New Apps support installation on other accounts; if you previously created a private App, enable installation on other accounts in GitHub App settings without replacing its credentials. GitHub controls repository access within each installation; Dolly separately restricts which installation accounts it will use. The setup page and callback at `/api/setup/github/:state` and `/api/setup/github/callback` require Access only; the callback returns the browser to `/`.

List the GitHub users and organizations dolly can work in under **Accounts dolly can work in** in **Settings** (`PUT /api/integrations/github/accounts`). Names are case-insensitive. An unset or empty list denies every account. The policy survives restarts and applies to repository discovery, repository tools, Git checkout/fetch/push, and webhook intake/replies. Removing an account prevents subsequent GitHub requests even when an installation token was cached. It does not uninstall the App, stop an already-running request, or erase existing checkouts. The webhook sender list is separate: allowed accounts identify repository owners, while allowed senders identify who may issue `/pi` commands. GitHub may still deliver webhooks from other installations, but Dolly rejects their commands before repository lookup or agent admission.

The App grant and read/write/code token permission maps match [Open Session's public permission definitions](https://github.com/tellahq/opensession/blob/main/packages/core/opensession-server/src/shared/github-app-permissions.ts), retained in `src/github-permissions.ts`. The grant includes Actions, Checks, Contents, Pull requests, Issues and Deployments write, plus Statuses, Members and Metadata read. Installation tokens are narrowed by operation and repository. Existing Apps must accept these permission updates in GitHub settings; no replacement App key is needed. This grants no Administration or Workflows permission. The copied definitions retain their MIT notice in `third_party/opensession/LICENSE`.

Setup links expire after one hour and survive Worker eviction. Repeating setup preserves an existing connection. A consumed callback cannot be replayed. If conversion fails, start setup again; if GitHub created an unused App, remove it in GitHub settings before creating another. App private keys and the App's client ID remain in Durable Object storage; the client ID runs GitHub sign-in. The webhook signing secret stays server-side, and short-lived installation tokens stay in Worker memory. GitHub sign-in uses the user token only to read the signed-in account and does not store it; sessions are stored as hashes.

Only the setup routes and `GET /api/auth`, `POST /api/auth/github` and `GET /api/auth/github` (sign-in) work without a session. Creating the GitHub App also works without a session, but only until someone has signed in and owns dolly.

New agent sessions have a `github` tool. It discovers repositories across App installations, reads UTF-8 files up to 32 KiB, creates `dolly/*` branches, writes files up to 32 KiB with an expected file SHA, and opens pull requests. It cannot merge, write the default branch, or edit `.github/workflows/`. Use a new path without `sha` only when creating a file. Mutations are not automatically replayed after interruption; inspect GitHub before retrying an uncertain write.

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

Repository enrolment follows Open Session's separation between App grants and workspace registration. `GET /api/integrations/github/repositories?available=true` discovers App repositories in allowed accounts, including privacy, description, default branch and registration status. `GET /api/integrations/github/repositories` lists enrolled repositories in currently allowed accounts without contacting GitHub. `POST` to that route with `{"repository":"owner/name"}` validates current App availability and durably enrolls it; `DELETE` with the same body removes it. Enrolment is case-insensitive and idempotent. Removing an entry does not uninstall the App, revoke access or delete existing checkouts. Enrolment is a picker/name-resolution preference, not an additional authorization boundary: explicit `owner/name` operations still use live GitHub authorization and the account policy. Short names resolve only against enrolled repos; ambiguous names require the user to choose an owner.

Pushes authenticate as the App installation, not the person who installed it. Local commit author metadata is configured as Dolly. With this repository's `rozenmd`-only CI policy, App-authored pushes do not start CI. Connected-user authorization is not included.

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

Send that JSON to `POST /api/sessions`, then submit a task through its messages route. The agent has a `workspace` tool to check out, inspect status/diff, commit, push, and open a PR. Its `shell` tool runs in `/workspace/repo`, with Git, Node.js, Corepack, Python 3, curl and CA certificates installed. Use shell commands for edits and the repository's test suite. Other toolchains can be installed through hosts explicitly enabled for the session; not every repository uses the image's built-in tools.

You can also create a blank conversation and let the agent select a repository using `workspace` with `{"action":"checkout","repository":"another-owner/project","ref":"main"}`. Dependency network hosts are supplied by the API client when creating a repository session, not granted by the model. An omitted host list permits only brokered Git traffic. The HTTPS intercept trusts the Containers CA through the provided certificate environment settings; tools with their own certificate store may need configuration.

Each conversation has an optional primary repository and a `dolly/session-<conversation-id>` branch. The `workspace` tool's `repositories` action lists enrolled repos, the primary repo, attached checkouts and the active repo. `attach` accepts an `owner/name` or a unique enrolled short name, creates or reactivates an isolated checkout, and directs subsequent shell, file and Git operations there. It never replaces the primary repo, including when the workspace has no primary. `checkout` can also reactivate a repo and sets the primary if none exists. Reusing a checkout preserves its changes; requesting a conflicting ref fails rather than resetting it.

This adapts Open Session's [`list_repos`/`attach_repo` tools](https://github.com/tellahq/opensession/blob/main/packages/core/opensession-server/src/agents/slack/repos-tools.ts) and [primary/attached repository tracking](https://github.com/tellahq/opensession/blob/main/packages/core/opensession-server/src/server/session-repos.ts). Dolly uses a separate checkpointed sandbox per attached repo, rather than host worktrees in one filesystem. Each uses `/workspace/repo` within its own sandbox; cross-repo paths and files are not shared. Branches, pushes and PRs remain scoped to the active repository, and attachments inherit the primary's dependency-host policy without granting new hosts. Children inherit the primary repository/ref and network policy but get separate checkouts and branches, not the parent's attachments. PR webhook conversations start at `refs/pull/<number>/head` and push their own branch, not the original PR branch.

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

1. Deploy the main Worker with `pnpm run deploy` and the public receiver with `pnpm --dir ingress run deploy`. Keep the main hostname protected by Access; the separate ingress hostname must accept GitHub requests without Access. Preview URLs remain disabled for both Workers.
2. Enter the ingress Worker's URL when creating the GitHub App. The manifest subscribes to `issue_comment` and points the webhook at `<ingress>/hooks/github`. To change it later, edit **Ingress URL** in **Settings**; dolly updates the App's webhook through GitHub's API (`PATCH /app/hook/config`), so you don't edit it on GitHub. For an App created before this, enable its webhook in GitHub App settings, grant **Issues: Read-only**, subscribe to **Issue comments**, and approve the updated permissions for the existing installation.
3. Install the App on the repositories you want to use and sign in to ChatGPT before enabling command intake. List who may run commands under **Who can run /pi commands** in **Settings** (`PUT /api/integrations/github/webhook` with `{"senders":[...]}`).

The API also accepts `"secret"` when no signing secret is stored yet, or when deliberately rotating it. Existing App credentials and an already-configured signing secret are preserved. Configuration checks the App event subscription and permission. Every command checks the current repository installation against the signed installation ID; new grants and reinstalls do not require rebuilding a Dolly repository list.

An allowed user can post `/pi Read README.md and explain the project` as a new comment on a PR in a repository available to an App installation. The command must start the comment. Issue comments without a PR, edits, bot comments, other events, and comments without `/pi` do not trigger agents. Repository, installation, and both comment-author and sender identity are checked after HMAC-SHA256 verification over the exact request bytes.

Intake stores the conversation mapping, comment-ID receipt, and Pi delivery task together before returning `202`. It uses the signed comment ID rather than trusting the unsigned delivery header. Repeated deliveries resume the same task; additional commands on the same PR use the same conversation. Pi owns restart recovery and reply retries. Replies check the App bot's existing comment marker before posting, including after a lost response. GitHub comment visibility and deletion prevent a strict exactly-once guarantee.

`GET /api/integrations/github/threads` lists conversation IDs and delivery status/outcomes. Open a conversation through the existing session API or abort it with the existing session abort route. Reply failures retain a failed task outcome after five attempts and diagnostic details in Worker logs.

Payloads are capped at 256 KiB and command text at 16,384 characters. There are no application-imposed counts for repositories, allowed senders, PR threads, or commands per thread. Deduplication receipts are retained; storage grows with usage. Unconfigured intake or a missing Codex connection returns `503`; invalid signatures return `401` and disallowed identities/repositories/installations return `403`. GitHub does not automatically retry failed deliveries: use **Redeliver** in the App's recent deliveries after fixing configuration or availability. An accepted task remains durable even if GitHub misses the acknowledgement.

## API

The web UI uses these routes on the same origin. Every route except `/api/health` sits behind Cloudflare Access and, apart from setup and sign-in, requires the GitHub sign-in session cookie.

`POST /api/sessions` with `{"model":"gpt-6-sol"}` returns the new session's `id` and selected `model`. The optional `model` must be in Pi's pinned Codex catalog; unknown models return `400`. For example, `gpt-6-luna`, `gpt-6-sol`, and `gpt-6.1-terra` are supported by this version. Your subscription must also allow the selected model. An empty body or `{}` uses `CODEX_MODEL` from `cloudflare.config.ts`. Selection is saved with the conversation, survives restarts, and does not change other sessions.

A prompt returns `202` after durable admission, not after generation. Poll the session to read its Pi conversation view, including recent entries and live progress. Reuse the same UUID `requestId` when retrying the same prompt to avoid duplicate work. The snapshot contains a bounded recent transcript window, not an export of all history.

| Route                             | Operation                                                    |
| --------------------------------- | ------------------------------------------------------------ |
| `GET /api/health`                 | Liveness check (Access still protects the deployed hostname) |
| `GET /api/auth`                   | GitHub App, owner and signed-in user                         |
| `POST /api/auth/github`           | Start GitHub device sign-in                                  |
| `GET /api/auth/github`            | Poll GitHub sign-in; sets the session cookie when approved   |
| `DELETE /api/auth/session`        | Sign this browser out                                        |
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

Treat both session and task IDs as opaque strings. HTTP `requestId` values must be UUIDs: retrying the same request returns its original receipt, while reusing it with different content or options returns `409`. Unknown models and invalid inputs return `400`; delegation limits return `409`. Agents can message, inspect and cancel only their own direct children; the signed-in owner can access all sessions.

Aborting a parent also stops all descendants and pending deliveries. Aborting does not delete conversations or files, and a stopped child can receive new messages. New work admitted after an abort's snapshot is not part of that cancellation. Children cannot read a parent's workspace; container files remain ephemeral.

## Optional local development

To develop locally after installing dependencies, copy `.dev.vars.example` to `.dev.vars` and start the Worker with Docker running:

```sh
pnpm run dev
```

`ACCESS_LOCAL_DEV=true` in `.dev.vars` bypasses Access JWT verification; GitHub sign-in is still required. `.dev.vars` is ignored by Git and is only for local development. Never enable `ACCESS_LOCAL_DEV` in deployed configuration. The automated Worker tests use the same explicit bypass except for the Access authentication tests. GitHub App setup requires an HTTPS origin, so create the App from a deployed Worker. Local and deployed Durable Object storage are separate; each environment needs its own sign-ins.

## Effect architecture

Effect owns API workflows, schema validation, the Codex device protocol, credential serialization, timeouts, and stream and process cleanup. `Account`, `CodexProtocol`, `GitHub`, `GitHubAuth`, and `AgentApi` are explicit services wired with Layers. Owned request and upstream schemas use Effect Schema, not Zod.

Hono handles HTTP routes; Cloudflare Durable Objects host sessions. They run Effects at HTTP, RPC and Pi callback boundaries. Pi still owns durable task scheduling and transcript storage; Effect fibers do not replace Pi's recovery mechanism. Credential locking uses one Effect semaphore per account object, shared with Pi's Promise-based credential adapter. Scoped finalizers stop transcript watches and cancel sandbox readers and processes.

## Ownership and limits

- One `Agent` Durable Object owns the account credentials and Pi SQLite storage. Credential writes, refresh and logout share one serialized queue. Login grants survive object restarts; alarms resume pending Pi work.
- Each conversation gets a separate `Sandbox` Durable Object and Linux container. The agent has `shell` and Sandbox 1.0 `Files`-backed `read_file` tools. Commands run as an unprivileged user.
- Subscription credentials and GitHub credentials never enter the container. Direct container internet access is disabled. Git traffic uses a private per-session Worker broker; it can read only the selected repository and push only the session branch, never the default branch or a deletion. Dependency downloads use an optional per-session HTTPS hostname list, without injected credentials.
- Conversation history and repository selection are durable. Repository workspaces, including `.git` and uncommitted files, are checkpointed to private Artifacts repositories after foreground shell commands, including failed commands. The last completed checkpoint is restored after container replacement. A crash during a command can lose changes since that checkpoint; interrupted commands are never automatically rerun. Blank sessions without a repository remain ephemeral. Containers stop after five minutes of inactivity.
- Shell calls have a 60-second deadline and keep at most 32 KiB per output stream. File reads allow 64 KiB. Runs stop after 20 tool rounds. Interrupted shell calls are marked unsafe to replay because commands may have side effects.
- Authorization is unfinished. The current implementation accepts only the recorded GitHub owner, behind Cloudflare Access, and does not yet provide multi-user authorization. An authenticated browser can use the connected subscription, run sandbox commands, and read conversations. Rate limiting and public sandbox previews are not implemented. During initial setup, anyone your Access policy allows can create the GitHub App and claim ownership; restrict that policy before exposing the deployment.
- Worker storage holds OAuth secrets. Protect access to the Cloudflare account and local `.wrangler` data. Logs and transcript responses redact known tokens and OAuth fields while retaining diagnostic messages.

## Code quality

`pnpm-workspace.yaml` keeps a 24-hour minimum release age, with exact-version exceptions for existing dependencies published more recently. It permits dependency install scripts only for esbuild and workerd. New dependencies with unreviewed install scripts fail installation until approved or explicitly blocked.

`pnpm run check` runs oxfmt, Oxlint (warnings fail), and TypeScript, including in CI. Use `pnpm run format` to format files and `pnpm run lint:fix` for safe lint autofixes; run lint autofix before formatting.

All generic and Effect rules from [anti-slop](https://github.com/dmmulroy/anti-slop) are enabled in `oxlint.config.ts`. The plugin is vendored in `tools/oxlint/anti-slop/`, with its source revision and licenses recorded there. Vendored rules, generated output and installed agent tooling are excluded from lint and formatting. Keep `oxlint` and `@oxlint/plugins` on the same exact version when upgrading.

## Verification

```sh
pnpm run check         # oxfmt, Oxlint + anti-slop, TypeScript
pnpm test               # config, tooling, workerd and Effect lifecycle tests
pnpm run test:sandbox  # Container + Files integration, requires Docker
pnpm run build         # deployment dry run including Docker image build
```

The ordinary tests stub OpenAI only. They run Hono, Durable Objects, SQLite, credential locking, Pi generation and the Codex SSE adapter in workerd, including crash recovery and duplicate prompt admission. Coordination tests exercise model-driven delegation and waiting, restart during a wait, inherited and overridden models, child-scoped messaging, recursive cancellation, depth/width/delivery limits, and unanswered child results. Effect tests cover interruption cleanup, permit release and TestClock-driven expiry. GitHub sign-in tests stub GitHub's device flow and cover ownership, refusal of other accounts, sessions and sign-out. Container integration checks actual execution, file reads and isolation. The current Vitest plugin only prepares containers through its legacy loader, so sandbox tests generate an ignored `.sandbox-test.wrangler.json` from `cloudflare.config.ts` using Cloudflare's converter. This is test-only compatibility output, not another configuration source. Access tests generate RSA keys and verify signed JWTs against a fixture JWKS, including rejection of missing configuration, forged signatures, wrong issuers/audiences and expired tokens. No test uses a real subscription or creates a Cloudflare Access policy. A successful live login and model/tool round trip remain the final deployment smoke test.

## References

- [Pi Durable Cloudflare example](https://github.com/earendil-works/pi-durable-cloudflare), for Durable Object SQLite storage and alarm-driven recovery.
- [Cloudflare Sandbox SDK](https://github.com/cloudflare/sandbox-sdk), for the 1.0 Container API and `Files` integration.
- [Open Session device login](https://github.com/tellahq/opensession/blob/main/packages/core/opensession-server/src/server/codex-device-login.ts) and [refresh ownership](https://github.com/tellahq/opensession/blob/main/packages/core/opensession-server/src/server/codex-token-refresh.ts), for subscription sign-in and token rotation constraints. That server uses the Codex CLI; this Worker implements the headless device protocol and delegates refresh and model requests to Pi's Codex provider.
