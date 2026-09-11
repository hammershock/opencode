import { Effect, Layer, LayerMap } from "effect"
import { AgentV2 } from "./agent"
import { AISDK } from "./aisdk"
import { Catalog } from "./catalog"
import { CommandV2 } from "./command"
import { Config } from "./config"
import { LayerNode } from "./effect/layer-node"
import { Node } from "./effect/app-node"
import { FileMutation } from "./file-mutation"
import { FSUtil } from "./fs-util"
import { FileSystem } from "./filesystem"
import { FileSystemSearch } from "./filesystem/search"
import { Watcher } from "./filesystem/watcher"
import { Image } from "./image"
import { Integration } from "./integration"
import { InstructionContext } from "./instruction-context"
import { Location } from "./location"
import { LocationMutation } from "./location-mutation"
import { LocationEnvironment } from "./location-environment"
import { LocationProcess } from "./location-process"
import { LocationFormatter } from "./location-formatter"
import { LocationServiceMap } from "./location-service-map"
import { ModelContextAssembler } from "./model-context-assembler"
import { PermissionV2 } from "./permission"
import { PluginV2 } from "./plugin"
import { PluginInternal } from "./plugin/internal"
import { Policy } from "./policy"
import { ProjectCopy } from "./project/copy"
import { Pty } from "./pty"
import { QuestionV2 } from "./question"
import { Reference } from "./reference"
import { ReferenceGuidance } from "./reference/guidance"
import * as SessionRunnerLLM from "./session/runner/llm"
import { SessionRunnerModel } from "./session/runner/model"
import { SessionTodo } from "./session/todo"
import { SkillV2 } from "./skill"
import { SkillGuidance } from "./skill/guidance"
import { SkillCatalogContext } from "./skill/catalog-context"
import { SkillPackageAccess } from "./skill/package-access"
import { Snapshot } from "./snapshot"
import { SystemContextBuiltIns } from "./system-context/builtins"
import { SystemContextRegistry } from "./system-context/registry"
import { BuiltInTools } from "./tool/builtins"
import { ReadToolFileSystem } from "./tool/read-filesystem"
import { ToolRegistry } from "./tool/registry"
import { ToolOutputStore } from "./tool-output-store"

export { LocationServiceMap } from "./location-service-map"

export const locationServices = LayerNode.group([
  Location.node,
  FSUtil.locationNode,
  Policy.node,
  Config.node,
  AgentV2.node,
  CommandV2.node,
  Reference.node,
  Integration.node,
  Catalog.node,
  AISDK.node,
  PluginV2.node,
  PluginInternal.node,
  ProjectCopy.node,
  ProjectCopy.refreshNode,
  FileSystemSearch.node,
  FileSystem.node,
  Watcher.node,
  Pty.node,
  SkillV2.node,
  SkillPackageAccess.node,
  SkillCatalogContext.node,
  SystemContextRegistry.node,
  InstructionContext.node,
  SystemContextBuiltIns.node,
  LocationMutation.node,
  LocationEnvironment.node,
  LocationProcess.node,
  LocationFormatter.node,
  FileMutation.node,
  PermissionV2.node,
  ToolOutputStore.node,
  ToolRegistry.node,
  ToolRegistry.toolsNode,
  Image.node,
  SkillGuidance.node,
  ReferenceGuidance.node,
  ModelContextAssembler.node,
  SessionTodo.node,
  QuestionV2.node,
  ReadToolFileSystem.node,
  BuiltInTools.node,
  SessionRunnerModel.node,
  Snapshot.node,
  SessionRunnerLLM.node,
])

export type LocationServices = LayerNode.Output<typeof locationServices>
export type LocationError = LayerNode.Error<typeof locationServices>

export interface LocationProvider {
  readonly target: Location.Target["type"]
  readonly build: (
    ref: Location.Ref,
    replacements: LayerNode.Replacements,
  ) => Layer.Layer<LocationServices, LocationError>
}

export const localProvider: LocationProvider = {
  target: "local",
  build: buildLocalLocation,
}

export function buildLocationServiceMap(
  replacements: LayerNode.Replacements = [],
  providers: ReadonlyArray<LocationProvider> = [localProvider],
): Layer.Layer<LocationServiceMap.Service> {
  const indexed = new Map(providers.map((provider) => [provider.target, provider]))
  return Layer.effect(
    LocationServiceMap.Service,
    Effect.map(
      LayerMap.make(
        (ref: Location.Ref) => {
          const provider = indexed.get(ref.target.type)
          if (!provider) throw new LocationServiceMap.ProviderUnavailableError({ target: ref.target.type })
          return provider.build(ref, replacements).pipe(
            Layer.tap(() =>
              Effect.logInfo("booting location services", {
                target: ref.target,
                directory: ref.directory,
                workspaceID: ref.workspaceID,
              }),
            ),
          )
        },
        { idleTimeToLive: "60 minutes" },
      ),
      (locations) => ({
        ...locations,
        get: (ref: Location.Ref) => locations.get(canonicalRef(ref)),
        contextEffect: (ref: Location.Ref) => locations.contextEffect(canonicalRef(ref)),
        invalidate: (ref: Location.Ref) => locations.invalidate(canonicalRef(ref)),
      }),
    ),
  )
}

function canonicalRef(ref: Location.Ref): Location.Ref {
  return Location.Ref.make({
    target: ref.target,
    directory: ref.directory,
    ...(ref.workspaceID === undefined ? {} : { workspaceID: ref.workspaceID }),
    ...(ref.lastKnownTargetName === undefined ? {} : { lastKnownTargetName: ref.lastKnownTargetName }),
  })
}

function buildLocalLocation(ref: Location.Ref, replacements: LayerNode.Replacements) {
  const allReplacements = replacements.concat([[Location.node, Location.boundNode(ref)]])
  // Apply replacements during hoist, not afterward: replacements can
  // introduce new tagged dependencies (Location.boundNode depends on
  // Project), and the hoist walk is the only pass that can still slice
  // those back out.
  const location = LayerNode.hoist(locationServices, Node.tags.values.global, allReplacements)
  return LayerNode.compile(location.node).pipe(Layer.fresh, Layer.provide(LayerNode.compile(location.hoisted)))
}

// This is temporary for backwards compatibility
export const locationServiceMapLayer = buildLocationServiceMap()
