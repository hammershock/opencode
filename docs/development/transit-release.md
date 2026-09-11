# OpenCode Transit releases

The fork-owned `transit release` workflow builds the two supported targets from one exact, clean `dev` commit:

- macOS Apple Silicon (`darwin-arm64`)
- Windows WSL2 Ubuntu (`linux-x64`)

Run the workflow from `dev`, choose the Transit sequence number, and leave `publish` disabled for a build-only verification run. The release tag is `v<upstream-version>-transit.N`; each binary reports the same version plus its 12-character source commit.

Every target produces a build manifest and SHA-256 checksum. The workflow verifies the commit, version, target, and clean-worktree flag before uploading an Actions artifact. Publishing is restricted to Hammer's fork and uses the exact workflow commit as the GitHub Release target.

## Prereleases

Choose `prerelease` when Apple release credentials are unavailable. The workflow publishes unsigned macOS and Linux archives only as a GitHub prerelease. Each archive includes `opencode-transit`, its build manifest, and `install-transit`.

## Stable macOS releases

Stable publication fails closed unless all of these GitHub Actions secrets are configured:

- `APPLE_CERTIFICATES_P12`: base64-encoded PKCS#12 bundle containing the Developer ID Application and Developer ID Installer certificates
- `APPLE_CERTIFICATES_PASSWORD`: password for that bundle
- `APPLE_APPLICATION_IDENTITY`: exact Developer ID Application identity
- `APPLE_INSTALLER_IDENTITY`: exact Developer ID Installer identity
- `APPLE_ID`: App Store Connect Apple ID used for notarization
- `APPLE_TEAM_ID`: Apple Developer team ID
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for `notarytool`

The stable path signs the CLI with hardened runtime and a trusted timestamp, creates and signs a flat installer package, waits for Apple notarization, staples and validates the ticket, checks the installer signature, and asks Gatekeeper to assess the package. A failure at any step prevents artifact upload and release publication.

The workflow never sends these credentials to build manifests, artifacts, command output, or the Linux job. The temporary keychain exists only on the ephemeral GitHub-hosted macOS runner.

## Installation boundary

Release installation creates `opencode-transit` and the temporary `opencode-rexd` compatibility launcher. It never creates or replaces `opencode`. Transit intentionally continues to use OpenCode's existing internal package and user-data namespaces; see [RFC-0013](../rfcs/0013-opencode-transit-identity.md) for the compatibility boundary.

For local build and isolated installation commands, see [`opencode-transit` development entrypoint](opencode-transit.md).
