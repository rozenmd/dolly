import type { Agent } from "./agent";
import type { Sandbox } from "./sandbox";

export interface Env {
  API_TOKEN: string;
  ASSETS: Fetcher;
  WORKSPACES: Artifacts;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ACCESS_LOCAL_DEV?: string;
  CODEX_MODEL: string;
  GITHUB_WEBHOOK_URL?: string;
  AGENT: DurableObjectNamespace<Agent>;
  SANDBOX: DurableObjectNamespace<Sandbox>;
}
