export * as OpenCodeSessionRunnerModel from "./runner-model"

import { Auth } from "@/auth"
import { Catalog } from "@opencode-ai/core/catalog"
import { Credential } from "@opencode-ai/core/credential"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Integration } from "@opencode-ai/core/integration"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { Effect, Layer } from "effect"

const layer = Layer.effect(
  SessionRunnerModel.Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service

    return SessionRunnerModel.Service.of({
      resolve: Effect.fn("OpenCode.SessionRunnerModel.resolve")(function* (session) {
        const available = yield* catalog.model.available()
        const defaultModel = session.model ? undefined : yield* catalog.model.default()
        const selected = session.model
          ? available.find((model) => model.providerID === session.model?.providerID && model.id === session.model.id)
          : defaultModel && SessionRunnerModel.supported(defaultModel)
            ? defaultModel
            : available.find(SessionRunnerModel.supported)

        if (selected) {
          const provider = yield* catalog.provider.get(selected.providerID)
          const connection = yield* integrations.connection.active(
            provider?.integrationID ?? Integration.ID.make(selected.providerID),
          )
          return yield* SessionRunnerModel.resolve(
            session,
            selected,
            connection ? yield* integrations.connection.resolve(connection) : undefined,
          )
        }

        if (!session.model) return yield* new SessionRunnerModel.ModelNotSelectedError({ sessionID: session.id })
        const model = yield* catalog.model.get(session.model.providerID, session.model.id)
        const provider = yield* catalog.provider.get(session.model.providerID)
        const credential = yield* auth.get(session.model.providerID).pipe(
          Effect.map(legacyCredential),
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (!model?.enabled || provider?.disabled || !credential)
          return yield* new SessionRunnerModel.ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        return yield* SessionRunnerModel.resolve(session, model, credential)
      }),
    })
  }),
)

export function legacyCredential(info: Auth.Info | undefined): Credential.Value | undefined {
  if (info?.type === "api") return Credential.Key.make({ type: "key", key: info.key, metadata: info.metadata })
  if (info?.type === "oauth")
    return Credential.OAuth.make({
      type: "oauth",
      methodID: Integration.MethodID.make("legacy"),
      refresh: info.refresh,
      access: info.access,
      expires: info.expires,
      metadata: {
        ...(info.accountId === undefined ? {} : { accountId: info.accountId }),
        ...(info.enterpriseUrl === undefined ? {} : { enterpriseUrl: info.enterpriseUrl }),
      },
    })
}

export const node = LayerNode.make({
  service: SessionRunnerModel.Service,
  layer,
  deps: [Auth.node, Catalog.node, Integration.node],
})
