import { FileMutation } from "@opencode-ai/core/file-mutation"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { FileSystemSearch } from "@opencode-ai/core/filesystem/search"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { LocationProcess } from "@opencode-ai/core/location-process"
import { LocationEnvironment } from "@opencode-ai/core/location-environment"
import { LocationFormatter } from "@opencode-ai/core/location-formatter"
import { locationServices, type LocationProvider } from "@opencode-ai/core/location-services"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Node } from "@opencode-ai/core/effect/app-node"
import { ReadToolFileSystem } from "@opencode-ai/core/tool/read-filesystem"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Pty } from "@opencode-ai/core/pty"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SkillPackageAccess } from "@opencode-ai/core/skill/package-access"
import { Layer } from "effect"
import { rexdFilesystemNodes } from "./location-filesystem"
import { rexdMutationNodes } from "./location-mutation"
import { rexdProcessNode } from "./location-process"
import { rexdReadNode } from "./location-read"
import { rexdPtyNode } from "./location-pty"
import { rexdLocationNode, rexdSessionNode } from "./location-session"
import { rexdEnvironmentSourceNode } from "./location-environment"
import { rexdFormatterNode } from "./location-formatter"
import { rexdSnapshotNode } from "./location-snapshot"
import { rexdSkillPackageAccessNode } from "./skill-package-access"

export const rexdLocationProvider: LocationProvider = {
  target: "rexd",
  build(ref, replacements) {
    if (ref.target.type !== "rexd") throw new Error("Rexd provider received a local Location")
    const session = rexdSessionNode(ref)
    const filesystem = rexdFilesystemNodes(session, ref.target.targetID, ref.directory)
    const mutation = rexdMutationNodes(session, ref.target.targetID, ref.directory)
    const environment = rexdEnvironmentSourceNode(session, ref.target.targetID)
    const selected = replacements.concat([
      [Location.node, rexdLocationNode(ref, session)],
      [LocationEnvironment.sourceDefaultNode, environment],
      [LocationFormatter.node, rexdFormatterNode(session)],
      [FileSystemSearch.node, filesystem[0]],
      [FileSystem.node, filesystem[1]],
      [FSUtil.locationNode, filesystem[2]],
      [LocationProcess.node, rexdProcessNode(session)],
      [LocationMutation.node, mutation[0]],
      [FileMutation.node, mutation[1]],
      [ReadToolFileSystem.node, rexdReadNode(session, ref.target.targetID, ref.directory)],
      [Pty.node, rexdPtyNode(session)],
      [Snapshot.node, rexdSnapshotNode],
      [SkillPackageAccess.node, rexdSkillPackageAccessNode(session, ref.target.targetID)],
    ])
    const location = LayerNode.hoist(locationServices, Node.tags.values.global, selected)
    return LayerNode.compile(location.node).pipe(Layer.fresh, Layer.provide(LayerNode.compile(location.hoisted)))
  },
}
