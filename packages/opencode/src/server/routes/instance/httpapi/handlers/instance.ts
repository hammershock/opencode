import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import * as InstanceState from "@/effect/instance-state"
import { Format } from "@/format"
import { Global } from "@opencode-ai/core/global"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillCatalogContextService } from "@opencode-ai/core/skill/catalog-context-service"
import { SkillV2 } from "@opencode-ai/core/skill"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ApiVcsApplyError } from "../groups/instance"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import { markInstanceForDisposal } from "../lifecycle"

export const instanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "instance", (handlers) =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const command = yield* Command.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const locations = yield* LocationServiceMap.Service
    const vcs = yield* Vcs.Service

    const dispose = Effect.fn("InstanceHttpApi.dispose")(function* () {
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    const getPath = Effect.fn("InstanceHttpApi.path")(function* () {
      const ctx = yield* InstanceState.context
      return {
        home: Global.Path.home,
        state: Global.Path.state,
        config: Global.Path.config,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }
    })

    const getVcs = Effect.fn("InstanceHttpApi.vcs")(function* () {
      const [branch, default_branch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], {
        concurrency: "unbounded",
      })
      return { branch, default_branch }
    })

    const getVcsStatus = Effect.fn("InstanceHttpApi.vcsStatus")(function* () {
      return yield* vcs.status()
    })

    const getVcsDiff = Effect.fn("InstanceHttpApi.vcsDiff")(function* (ctx: {
      query: { mode: Vcs.Mode; context?: number }
    }) {
      return yield* vcs.diff(ctx.query.mode, { context: ctx.query.context })
    })

    const getVcsDiffRaw = Effect.fn("InstanceHttpApi.vcsDiffRaw")(function* () {
      return yield* vcs.diffRaw()
    })

    const applyVcs = Effect.fn("InstanceHttpApi.vcsApply")(function* (ctx: { payload: Vcs.ApplyInput }) {
      return yield* vcs.apply(ctx.payload).pipe(
        Effect.mapError(
          (error) =>
            new ApiVcsApplyError({
              name: "VcsApplyError",
              data: {
                message: error.message,
                reason: error.reason,
              },
            }),
        ),
      )
    })

    const getCommand = Effect.fn("InstanceHttpApi.command")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const route = yield* WorkspaceRouteContext
      const targetID = request.headers["x-opencode-target"]
      const url = new URL(request.url, "http://localhost")
      const directory = targetID
        ? (url.searchParams.get("directory") ?? request.headers["x-opencode-directory"] ?? route.directory)
        : route.directory
      const catalog = yield* SkillCatalogContextService.Service.use((skills) =>
        skills.load({ forceReload: false }),
      ).pipe(
        Effect.provide(
          locations.get(
            Location.Ref.make({
              target: targetID
                ? Location.RexdTarget.make({ type: "rexd", targetID: Location.TargetID.make(targetID) })
                : Location.LocalTarget.make({ type: "local" }),
              directory: AbsolutePath.make(directory),
              workspaceID: route.workspaceID,
            }),
          ),
        ),
      )
      const commands = yield* command.list()
      return Command.withSkillCompatibility(commands, catalog.snapshot.skills)
    })

    const getAgent = Effect.fn("InstanceHttpApi.agent")(function* () {
      return yield* agent.list()
    })

    const getSkill = Effect.fn("InstanceHttpApi.skill")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const route = yield* WorkspaceRouteContext
      const targetID = request.headers["x-opencode-target"]
      const url = new URL(request.url, "http://localhost")
      const directory = targetID
        ? (url.searchParams.get("directory") ?? request.headers["x-opencode-directory"] ?? route.directory)
        : route.directory
      return yield* Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        yield* plugin.wait(PluginV2.ID.make("config-skill"))
        return yield* (yield* SkillV2.Service).list()
      }).pipe(
        Effect.provide(
          locations.get(
            Location.Ref.make({
              target: targetID
                ? Location.RexdTarget.make({ type: "rexd", targetID: Location.TargetID.make(targetID) })
                : Location.LocalTarget.make({ type: "local" }),
              directory: AbsolutePath.make(directory),
              workspaceID: route.workspaceID,
            }),
          ),
        ),
      )
    })

    const getLsp = Effect.fn("InstanceHttpApi.lsp")(function* () {
      return yield* lsp.status()
    })

    const getFormatter = Effect.fn("InstanceHttpApi.formatter")(function* () {
      return yield* format.status()
    })

    return handlers
      .handle("dispose", dispose)
      .handle("path", getPath)
      .handle("vcs", getVcs)
      .handle("vcsStatus", getVcsStatus)
      .handle("vcsDiff", getVcsDiff)
      .handle("vcsDiffRaw", getVcsDiffRaw)
      .handle("vcsApply", applyVcs)
      .handle("command", getCommand)
      .handle("agent", getAgent)
      .handle("skill", getSkill)
      .handle("lsp", getLsp)
      .handle("formatter", getFormatter)
  }),
)
