#!/usr/bin/env bash
set -euo pipefail

repo="hammershock/opencode"
asset="opencode-rexd-darwin-arm64.tar.gz"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This release currently supports macOS arm64 only." >&2
  exit 1
fi

tmp="$(mktemp -d)"
cleanup() {
  if command -v trash >/dev/null 2>&1; then
    trash "$tmp"
  else
    rm -rf "$tmp"
  fi
}
trap cleanup EXIT

base="https://github.com/${repo}/releases/latest/download"
curl -fL --retry 3 "${base}/${asset}" -o "${tmp}/${asset}"
curl -fL --retry 3 "${base}/${asset}.sha256" -o "${tmp}/${asset}.sha256"
(cd "$tmp" && shasum -a 256 -c "${asset}.sha256")
tar -xzf "${tmp}/${asset}" -C "$tmp"

bin_dir="${HOME}/.local/bin"
install_dir="${HOME}/.local/lib/opencode-rexd"
plugin_dir="${HOME}/.config/opencode/plugins"
command_dir="${HOME}/.config/opencode/commands"
mkdir -p "$bin_dir" "$install_dir" "$plugin_dir" "$command_dir"

if [[ -f "${plugin_dir}/rexd-target.js" ]]; then
  cp "${plugin_dir}/rexd-target.js" "${plugin_dir}/rexd-target.js.$(date +%Y%m%d%H%M%S).bak"
fi

install -m 755 "${tmp}/opencode-rexd" "${install_dir}/opencode-rexd"
install -m 644 "${tmp}/rexd-target.js" "${plugin_dir}/rexd-target.js"
install -m 644 "${tmp}/rexd-target-tree-sitter.wasm" "${plugin_dir}/rexd-target-tree-sitter.wasm"
install -m 644 "${tmp}/rexd-target-tree-sitter-bash.wasm" "${plugin_dir}/rexd-target-tree-sitter-bash.wasm"
install -m 644 "${tmp}/commands/target.md" "${command_dir}/target.md"
install -m 644 "${tmp}/commands/cd.md" "${command_dir}/cd.md"
install -m 644 "${tmp}/commands/permissions.md" "${command_dir}/permissions.md"
ln -sfn "${install_dir}/opencode-rexd" "${bin_dir}/opencode-rexd"
codesign --force --sign - "${install_dir}/opencode-rexd" >/dev/null

echo "Installed: ${bin_dir}/opencode-rexd"
echo "Run: opencode-rexd"
