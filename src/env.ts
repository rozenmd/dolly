import type { Agent } from "./agent";
import type { Sandbox } from "./sandbox";

export interface Env {
  ASSETS: Fetcher;
  WORKSPACES?: Artifacts;
  SCREENSHOTS: R2Bucket;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ACCESS_LOCAL_DEV?: string;
  CODEX_MODEL: string;
  AGENT: DurableObjectNamespace<Agent>;
  SANDBOX: DurableObjectNamespace<Sandbox>;
}
