#!/usr/bin/env bun

import { $ } from "bun"
import { rename } from "node:fs/promises"
import path from "path"
import pkg from "../package.json"

const commit = await $`git rev-parse HEAD`.text().then((value) => value.trim())
const dirty = (await $`git status --short`.text()).trim().length > 0
const release = process.env.OPENCODE_TRANSIT_RELEASE ?? "0"
if (!/^\d+$/.test(release)) throw new Error("OPENCODE_TRANSIT_RELEASE must be a non-negative integer")
const version = `${pkg.version}-transit.${release}+${commit.slice(0, 12)}${dirty ? ".dirty" : ""}`

process.env.OPENCODE_VERSION = version
process.env.OPENCODE_CHANNEL = "transit"
process.env.OPENCODE_PLUGIN_VERSION = pkg.version

await import("./build.ts")

const artifacts = (await Array.fromAsync(new Bun.Glob("opencode-*/bin/opencode*").scan({ cwd: "dist" }))).filter((artifact) =>
  ["opencode", "opencode.exe"].includes(path.basename(artifact)),
)
if (artifacts.length === 0) throw new Error("OpenCode build produced no executable artifacts")

await Promise.all(
  artifacts.map(async (artifact) => {
    const directory = path.dirname(path.join("dist", artifact))
    const target = path.basename(path.dirname(directory))
    const source = path.join("dist", artifact)
    const destination = path.join(directory, artifact.endsWith(".exe") ? "opencode-transit.exe" : "opencode-transit")
    await rename(source, destination)
    await Bun.write(
      path.join(directory, "opencode-transit.build.json"),
      JSON.stringify(
        {
          product: "OpenCode Transit",
          entrypoint: "opencode-transit",
          version,
          upstreamVersion: pkg.version,
          commit,
          dirty,
          target,
          builtAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    )
  }),
)

console.log(`Built opencode-transit ${version} (${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"})`)
