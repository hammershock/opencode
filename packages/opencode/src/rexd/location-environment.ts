import path from "node:path"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { LocationEnvironment } from "@opencode-ai/core/location-environment"
import { Effect, Layer } from "effect"
import { RexdFiles } from "./location-files"
import { runRexdProcess } from "./location-process"
import { RexdLocationSession } from "./location-session"

export function rexdEnvironmentSourceNode(
  session: ReturnType<typeof import("./location-session").rexdSessionNode>,
  targetID: string,
) {
  return makeLocationNode({
    service: LocationEnvironment.Source,
    layer: Layer.effect(
      LocationEnvironment.Source,
      Effect.gen(function* () {
        const lease = yield* RexdLocationSession
        const files = new RexdFiles(targetID, lease)
        return LocationEnvironment.Source.of({
          capture: (input) =>
            Effect.tryPromise({
              try: async () => {
                const result = await runRexdProcess(lease, {
                  argv: ["env", "-0"],
                  shell: false,
                  cwd: input.directory,
                  timeout: "10 seconds",
                  maxOutputBytes: 4 * 1024 * 1024,
                })
                if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8"))
                const base = Object.fromEntries(
                  result.stdout
                    .toString("utf8")
                    .split("\0")
                    .flatMap((line) => {
                      const index = line.indexOf("=")
                      return index > 0 ? [[line.slice(0, index), line.slice(index + 1)]] : []
                    }),
                )
                const home = base.HOME
                const candidates = [
                  ...(home ? [{ path: path.posix.join(home, ".config/opencode/.env"), origin: "user" as const }] : []),
                  ...directories(input.workspaceRoot, input.directory).map((directory) => ({
                    path: path.posix.join(directory, ".env"),
                    origin: "project" as const,
                  })),
                ]
                const sources = await Promise.all(
                  candidates.map(async (item) => {
                    const stat = await files.stat(item.path, input.directory)
                    if (!stat.exists || stat.type !== "file") return item
                    return {
                      ...item,
                      content: Buffer.from((await files.read(item.path, input.directory)).content).toString("utf8"),
                    }
                  }),
                )
                return { base, files: sources }
              },
              catch: () =>
                new LocationEnvironment.SourceError({ source: input.directory, code: "remote-capture-failed" }),
            }),
          ensureTemplate: (directory, content) =>
            Effect.tryPromise({
              try: async () => {
                const target = path.posix.join(directory, ".env")
                if ((await files.stat(target, directory)).exists) return "existing" as const
                await files.write(target, directory, Buffer.from(content), { mode: "create" })
                return "created" as const
              },
              catch: () => new LocationEnvironment.SourceError({ source: directory, code: "remote-write-failed" }),
            }),
        })
      }),
    ),
    deps: [session],
  })
}

function directories(root: string, directory: string) {
  const relative = path.posix.relative(root, directory)
  if (!relative || relative.startsWith("..") || path.posix.isAbsolute(relative)) return [directory]
  return relative.split("/").reduce((items, segment) => [...items, path.posix.join(items.at(-1)!, segment)], [root])
}
