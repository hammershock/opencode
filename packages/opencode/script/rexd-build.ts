#!/usr/bin/env bun

console.error("script/rexd-build.ts is deprecated; use script/transit-build.ts")
await import("./transit-build.ts")
