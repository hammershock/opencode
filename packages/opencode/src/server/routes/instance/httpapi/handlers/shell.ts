import { Location } from "@opencode-ai/core/location"
import { SessionPrompt } from "@/session/prompt"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ShellCompletionPayload } from "../groups/shell"

export const shellHandlers = HttpApiBuilder.group(InstanceHttpApi, "shell", (handlers) =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    return handlers.handle("complete", (ctx: { payload: typeof ShellCompletionPayload.Type }) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        return yield* prompt
          .completeShellAtLocation({
            ...ctx.payload,
            location: Location.Ref.make(location),
          })
          .pipe(Effect.catch(Effect.die))
      }),
    )
  }),
)
