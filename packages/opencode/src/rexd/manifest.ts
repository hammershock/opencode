export const REXD_BASELINE_VERSION = "v0.1.5"

export const REXD_ARTIFACTS = {
  "linux-amd64": {
    name: "rexd-linux-amd64.tar.gz",
    sha256: "773f0d05cd0ea4f2ba1414b74b59467942e03da674c6ea45ff1a84f8707fe542",
  },
  "linux-arm64": {
    name: "rexd-linux-arm64.tar.gz",
    sha256: "7d48517c77c118f9934c0b6a1c3118cb3ba088cf14c89ba33636a292d4da4b8b",
  },
} as const

export type RexdPlatform = keyof typeof REXD_ARTIFACTS

export function artifactURL(platform: RexdPlatform) {
  return `https://github.com/samiralibabic/rexd/releases/download/${REXD_BASELINE_VERSION}/${REXD_ARTIFACTS[platform].name}`
}
