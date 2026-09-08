import { LocationQuery, locationQueryOpenApi } from "@opencode-ai/protocol/groups/location"
import { SessionPrompt } from "@/session/prompt"
import { Schema, Struct } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationMiddleware } from "@opencode-ai/server/location"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const ShellCompletionQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  ...LocationQuery.fields,
})

export const ShellCompletionPayload = Schema.Struct(
  Struct.omit(SessionPrompt.ShellLocationCompletionInput.fields, ["location"]),
)

export const ShellApi = HttpApi.make("shell").add(
  HttpApiGroup.make("shell")
    .add(
      HttpApiEndpoint.post("complete", "/api/shell/completion", {
        query: ShellCompletionQuery,
        payload: ShellCompletionPayload,
        success: described(SessionPrompt.ShellCompletionResult, "Shell completion candidates"),
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.shell.complete",
            summary: "Complete shell input",
            description: "Return User Shell completion candidates for a Location before a Session exists.",
          }),
        ),
    )
    .middleware(LocationMiddleware)
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
