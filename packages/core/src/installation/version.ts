declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  const OPENCODE_PLUGIN_VERSION: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationPluginVersion = resolvePluginVersion(
  InstallationVersion,
  typeof OPENCODE_PLUGIN_VERSION === "string" ? OPENCODE_PLUGIN_VERSION : undefined,
)
export const InstallationLocal = InstallationChannel === "local"

export function resolvePluginVersion(version: string, compatible?: string) {
  return compatible ?? version
}
