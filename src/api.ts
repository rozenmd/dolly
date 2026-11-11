import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { rpc } from "./operations";
import type { Env } from "./env";

function makeAgentApi(env: Env) {
  const agent = env.AGENT.getByName("owner");

  return {
    startLogin: rpc("agent.login.start", async () => await agent.startLogin()),
    pollLogin: rpc("agent.login.poll", async () => await agent.pollLogin()),
    logout: rpc("agent.logout", async () => await agent.logout()),
    createSession: Effect.fn("AgentApi.createSession")((model?: string) =>
      rpc("agent.session.create", async () => await agent.createSession(model)),
    ),
    transcript: Effect.fn("AgentApi.transcript")((id: string) =>
      rpc("agent.transcript", async () => await agent.transcript(id)),
    ),
    prompt: Effect.fn("AgentApi.prompt")((id: string, content: string, requestId: string) =>
      rpc("agent.prompt", async () => await agent.prompt(id, content, requestId)),
    ),
    abort: Effect.fn("AgentApi.abort")((id: string) =>
      rpc("agent.abort", async () => await agent.abort(id)),
    ),
  };
}

export class AgentApi extends Context.Service<AgentApi, ReturnType<typeof makeAgentApi>>()(
  "pi-hard/AgentApi",
) {
  static readonly layer = (env: Env) => Layer.sync(AgentApi, () => makeAgentApi(env));
}
