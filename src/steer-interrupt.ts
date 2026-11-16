import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type StreamFunction,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import type { InboxState } from "@earendil-works/pi-durable";

/** Tool result for calls skipped because a steer is waiting (the model reads it, then the steer). */
export const STEER_TOOL_SKIP =
  "Skipped because the user sent new instructions. Read them before choosing the next tool.";

/** Whether a conversation's inbox holds a steer the next boundary will place. */
export function steerQueued(inbox: InboxState | undefined) {
  return inbox?.items.some((item) => item.mode === "steer") === true;
}

/**
 * Whether a waiting steer may cut the current response short. Cutting it ends the turn, and the
 * final boundary that places the steer would also start the next queued follow-up early, so a
 * steer behind follow-ups waits for the next step boundary instead.
 */
export function steerInterrupts(inbox: InboxState | undefined) {
  return steerQueued(inbox) && !inbox?.items.some((item) => item.mode === "followUp");
}

/**
 * Whether a response has produced anything a person would lose: reply text or a tool call.
 * Thinking alone does not count; it is superseded by the steer.
 */
export function responseHasOutput(message: AssistantMessage | undefined) {
  return (
    message?.content.some(
      (block) =>
        block.type === "toolCall" || (block.type === "text" && block.text.trim().length > 0),
    ) === true
  );
}

type Request = {
  readonly conversationId: string;
  readonly controller: AbortController;
  partial?: AssistantMessage;
  interrupted: boolean;
};

type Binding = { readonly conversationId: string; steerPending: boolean };

/**
 * Cut a model response short when a steer arrives while the model is still only thinking.
 *
 * Pi places steers at tool boundaries, so a steer sent during a long reasoning phase would
 * otherwise wait for the whole response. While a response has written no reply text and no tool
 * call, an arriving steer aborts just that provider request. The response ends as an empty,
 * completed answer: providers drop empty assistant messages from later requests, and the turn's
 * final boundary places the steer, which starts the next run at once. A response that has
 * started writing or calling a tool is left to finish; its steer lands at the next boundary, as
 * does one queued behind follow-ups (`steerInterrupts`).
 *
 * Requests are matched to conversations by provider session ID: the generation's `beforeRequest`
 * hook binds the conversation's `pi.provider` session ID just before the request starts.
 */
export class SteerInterrupts {
  private readonly bindings = new Map<string, Binding>();
  private readonly requests = new Set<Request>();

  /** Announce the next request of `conversationId`, made with provider session `sessionId`. */
  bind(sessionId: string, conversationId: string, steerPending: boolean) {
    this.bindings.set(sessionId, { conversationId, steerPending });
  }

  /**
   * A steer was queued for `conversationId`: cut short each of its in-flight responses that has
   * no output yet, and mark a request about to start so it ends before sending. Returns whether
   * anything was interrupted or marked.
   */
  interrupt(conversationId: string) {
    let interrupted = false;

    for (const binding of this.bindings.values())
      if (binding.conversationId === conversationId) {
        binding.steerPending = true;
        interrupted = true;
      }

    for (const request of this.requests) {
      if (request.conversationId !== conversationId || request.interrupted) continue;

      if (responseHasOutput(request.partial)) continue;

      request.interrupted = true;
      request.controller.abort();
      interrupted = true;
    }

    return interrupted;
  }

  /** Wrap a provider stream function so steers can interrupt its thinking-only responses. */
  wrap<TApi extends Api, TOptions extends StreamOptions>(
    fn: StreamFunction<TApi, TOptions>,
  ): StreamFunction<TApi, TOptions> {
    return (model, context, options) => {
      const sessionId = options?.sessionId;
      const binding = sessionId === undefined ? undefined : this.bindings.get(sessionId);

      if (!binding || sessionId === undefined) return fn(model, context, options);
      this.bindings.delete(sessionId);

      const output = createAssistantMessageEventStream();

      // A steer queued before the request started: answer empty without sending anything.
      if (binding.steerPending) {
        output.push({ type: "done", reason: "stop", message: interruptedMessage(model) });
        output.end();

        return output;
      }

      const controller = new AbortController();

      const request: Request = {
        conversationId: binding.conversationId,
        controller,
        interrupted: false,
      };

      const signal = options?.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;

      this.requests.add(request);

      void (async () => {
        try {
          const upstream = fn(model, context, Object.assign({}, options, { signal }));

          for await (const event of upstream) {
            if (event.type === "done") {
              output.push(event);

              return;
            }

            if (event.type === "error") {
              // Our abort, not the caller's: end as an empty answer so the boundary places the steer.
              output.push(
                request.interrupted && !options?.signal?.aborted
                  ? {
                      type: "done",
                      reason: "stop",
                      message: interruptedMessage(model, request.partial ?? event.error),
                    }
                  : event,
              );

              return;
            }

            request.partial = event.partial;

            if (!request.interrupted) output.push(event);
          }

          const result = await upstream.result();

          output.end(
            request.interrupted && result.stopReason === "aborted" && !options?.signal?.aborted
              ? interruptedMessage(model, result)
              : result,
          );
        } catch (cause) {
          output.push({
            type: "error",
            reason: options?.signal?.aborted ? "aborted" : "error",
            error: {
              ...interruptedMessage(model, request.partial),
              stopReason: options?.signal?.aborted ? "aborted" : "error",
              errorMessage: cause instanceof Error ? cause.message : String(cause),
            },
          });
        } finally {
          this.requests.delete(request);
          output.end();
        }
      })();

      return output;
    };
  }
}

/** An empty completed answer, keeping the attempt's identity and usage when it has them. */
function interruptedMessage(model: Model<Api>, from?: AssistantMessage): AssistantMessage {
  const { errorMessage: _error, ...base } = from ?? {
    role: "assistant" as const,
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };

  return { ...base, content: [], stopReason: "stop" };
}
