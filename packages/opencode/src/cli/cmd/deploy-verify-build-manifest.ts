import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { cmd } from "./cmd"

const MAX_STDIN_BYTES = 16 * 1024

export async function verifyBuildManifestFromStream(
  input: AsyncIterable<Uint8Array | string>,
  version = InstallationVersion,
) {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of input) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    size += bytes.byteLength
    if (size > MAX_STDIN_BYTES) throw invalid("size")
    chunks.push(bytes)
  }
  if (!size) throw invalid("input")

  const manifest = parseManifest(Buffer.concat(chunks).toString("utf8"))
  if (manifest.product !== "OpenCode Transit") throw invalid("product")
  if (manifest.entrypoint !== "opencode-transit") throw invalid("entrypoint")
  if (manifest.version !== version) throw invalid("version")

  const identity = version.match(/^(.+)-transit\.\d+\+([0-9a-f]{12})(\.dirty)?$/)
  if (!identity) throw invalid("identity")
  if (manifest.upstreamVersion !== identity[1]) throw invalid("upstreamVersion")
  if (!/^[0-9a-f]{40}$/.test(manifest.commit)) throw invalid("commit")
  if (!manifest.commit.startsWith(identity[2])) throw invalid("commit")
  if (manifest.dirty !== Boolean(identity[3])) throw invalid("dirty")
  if (!manifest.target.trim()) throw invalid("target")
  if (!Number.isFinite(Date.parse(manifest.builtAt))) throw invalid("builtAt")
}

function parseManifest(value: string) {
  const manifest: unknown = (() => {
    try {
      return JSON.parse(value)
    } catch {
      throw invalid("json")
    }
  })()
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw invalid("shape")
  if (!("product" in manifest) || typeof manifest.product !== "string") throw invalid("shape")
  if (!("entrypoint" in manifest) || typeof manifest.entrypoint !== "string") throw invalid("shape")
  if (!("version" in manifest) || typeof manifest.version !== "string") throw invalid("shape")
  if (!("upstreamVersion" in manifest) || typeof manifest.upstreamVersion !== "string") throw invalid("shape")
  if (!("commit" in manifest) || typeof manifest.commit !== "string") throw invalid("shape")
  if (!("dirty" in manifest) || typeof manifest.dirty !== "boolean") throw invalid("shape")
  if (!("target" in manifest) || typeof manifest.target !== "string") throw invalid("shape")
  if (!("builtAt" in manifest) || typeof manifest.builtAt !== "string") throw invalid("shape")
  return {
    product: manifest.product,
    entrypoint: manifest.entrypoint,
    version: manifest.version,
    upstreamVersion: manifest.upstreamVersion,
    commit: manifest.commit,
    dirty: manifest.dirty,
    target: manifest.target,
    builtAt: manifest.builtAt,
  }
}

function invalid(reason: string) {
  return new Error(`Invalid build manifest (${reason})`)
}

async function* streamChunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield chunk.value
    }
  } finally {
    reader.releaseLock()
  }
}

/** Hidden release-operator entrypoint. It is intentionally absent from user help. */
export const DeployVerifyBuildManifestCommand = cmd({
  command: "__deploy-verify-build-manifest",
  describe: false,
  async handler() {
    await verifyBuildManifestFromStream(streamChunks(Bun.stdin.stream()))
  },
})
