import type { Agent } from "./agent";
import type { Sandbox } from "./sandbox";
import type { Codex } from "./codex";

export interface Env {
  ASSETS: Fetcher;
  SCREENSHOTS: R2Bucket;
  PR_SCREENSHOTS: R2Bucket;
  PR_SCREENSHOTS_URL: string;
  DEPENDENCY_CACHE: R2Bucket;
  BROWSER: BrowserRun;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ACCESS_LOCAL_DEV?: string;
  AGENT: DurableObjectNamespace<Agent>;
  SANDBOX: DurableObjectNamespace<Sandbox>;
  CODEX: DurableObjectNamespace<Codex>;
}
