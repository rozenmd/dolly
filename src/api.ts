import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { rpc } from "./operations";
import type { ChildRequest, ChildMessage, NewSession, SessionSettings } from "./models";
import type { PromptImage } from "./images";
import type { Env } from "./env";
import type { LoginCallback } from "./chatgpt-login";

function makeAgentApi(env: Env) {
  const agent = env.AGENT.getByName("owner");

  return {
    startLogin: rpc("agent.login.start", async () => await agent.startLogin()),
    loginStatus: rpc("agent.login.status", async () => await agent.loginStatus()),
    completeLogin: Effect.fn("AgentApi.completeLogin")((input: typeof LoginCallback.Type) =>
      rpc("agent.login.complete", async () => await agent.completeLogin(input)),
    ),
    logout: rpc("agent.logout", async () => await agent.logout()),
    createSession: Effect.fn("AgentApi.createSession")((input: typeof NewSession.Type) =>
      rpc("agent.session.create", async () => await agent.createSession(input)),
    ),
    configureSession: Effect.fn("AgentApi.configureSession")(
      (id: string, settings: typeof SessionSettings.Type) =>
        rpc("agent.session.configure", async () => await agent.configureSession(id, settings)),
    ),
    children: Effect.fn("AgentApi.children")((id: string) =>
      rpc("agent.children", async () => await agent.children(id)),
    ),
    spawnChild: Effect.fn("AgentApi.spawnChild")((id: string, input: typeof ChildRequest.Type) =>
      rpc("agent.child.spawn", async () => await agent.spawnChild(id, input)),
    ),
    sendChild: Effect.fn("AgentApi.sendChild")(
      (id: string, childId: string, input: typeof ChildMessage.Type) =>
        rpc("agent.child.send", async () => await agent.sendChild(id, childId, input)),
    ),
    childStatus: Effect.fn("AgentApi.childStatus")((id: string, childId: string) =>
      rpc("agent.child.status", async () => await agent.childStatus(id, childId)),
    ),
    transcript: Effect.fn("AgentApi.transcript")((id: string) =>
      rpc("agent.transcript", async () => await agent.transcript(id)),
    ),
    history: Effect.fn("AgentApi.history")((id: string, through: number, limit: number) =>
      rpc("agent.history", async () => await agent.history(id, through, limit)),
    ),
    prompts: Effect.fn("AgentApi.prompts")((id: string, through: number) =>
      rpc("agent.prompts", async () => await agent.prompts(id, through)),
    ),
    prompt: Effect.fn("AgentApi.prompt")(
      (
        id: string,
        content: string,
        requestId: string,
        images?: readonly PromptImage[],
        steer?: boolean,
      ) =>
        rpc("agent.prompt", async () => await agent.prompt(id, content, requestId, images, steer)),
    ),
    scheduledPrompts: Effect.fn("AgentApi.scheduledPrompts")((id: string) =>
      rpc("agent.schedule.list", async () => await agent.scheduledPrompts(id)),
    ),
    schedulePrompt: Effect.fn("AgentApi.schedulePrompt")(
      (id: string, input: { content: string; at: string; requestId: string }) =>
        rpc("agent.schedule.create", async () => await agent.schedulePrompt(id, input)),
    ),
    cancelScheduledPrompt: Effect.fn("AgentApi.cancelScheduledPrompt")(
      (id: string, scheduleId: string) =>
        rpc("agent.schedule.cancel", async () => await agent.cancelScheduledPrompt(id, scheduleId)),
    ),
    ciWait: Effect.fn("AgentApi.ciWait")((id: string) =>
      rpc("agent.ci-wait.read", async () => await agent.ciWait(id)),
    ),
    cancelCiWait: Effect.fn("AgentApi.cancelCiWait")((id: string) =>
      rpc("agent.ci-wait.cancel", async () => await agent.cancelCiWait(id)),
    ),
    abort: Effect.fn("AgentApi.abort")((id: string) =>
      rpc("agent.abort", async () => await agent.abort(id)),
    ),
    steerQueued: Effect.fn("AgentApi.steerQueued")((id: string, submissionId: number) =>
      rpc("agent.queue.steer", async () => await agent.steerQueued(id, submissionId)),
    ),
    withdrawQueued: Effect.fn("AgentApi.withdrawQueued")((id: string, submissionId: number) =>
      rpc("agent.queue.withdraw", async () => await agent.withdrawQueued(id, submissionId)),
    ),
    editQueued: Effect.fn("AgentApi.editQueued")((id: string, submissionId: number) =>
      rpc("agent.queue.edit", async () => await agent.editQueued(id, submissionId)),
    ),
    reorderQueue: Effect.fn("AgentApi.reorderQueue")((id: string, order: readonly number[]) =>
      rpc("agent.queue.reorder", async () => await agent.reorderQueue(id, order)),
    ),
  };
}

export class AgentApi extends Context.Service<AgentApi, ReturnType<typeof makeAgentApi>>()(
  "dolly/AgentApi",
) {
  static readonly layer = (env: Env) => Layer.sync(AgentApi, () => makeAgentApi(env));
}
