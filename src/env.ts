import type { Agent } from "./agent";
import type { Sandbox } from "./sandbox";

export interface Env {
  API_TOKEN: string;
  CODEX_MODEL: string;
  AGENT: DurableObjectNamespace<Agent>;
  SANDBOX: DurableObjectNamespace<Sandbox>;
}
