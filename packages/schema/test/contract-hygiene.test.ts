import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Agent } from "../src/agent"
import { FileSystem } from "../src/filesystem"
import { Model } from "../src/model"
import { Project } from "../src/project"
import { Pty } from "../src/pty"
import { Question } from "../src/question"
import { Session } from "../src/session"
import { SessionEvent } from "../src/session-event"
import { SessionTodo } from "../src/session-todo"
import { Skill } from "../src/skill"
import { optional } from "../src/schema"

describe("contract hygiene", () => {
  test("optional properties preserve transformations and omit undefined while encoding", () => {
    const Value = Schema.Struct({ value: optional(Schema.FiniteFromString) })
    expect(Schema.decodeUnknownSync(Value)({ value: "1" })).toEqual({ value: 1 })
    expect(Schema.encodeSync(Value)({ value: 1 })).toEqual({ value: "1" })
    expect(Schema.encodeSync(Value)({ value: undefined })).toEqual({})
  })

  test("todo status and priority preserve arbitrary strings", () => {
    const decode = Schema.decodeUnknownSync(SessionTodo.Info)
    expect(decode({ content: "ship", status: "waiting", priority: "urgent" })).toEqual({
      content: "ship",
      status: "waiting",
      priority: "urgent",
    })
  })

  test("current ID constructors expose create", () => {
    expect(Question.ID.create()).toStartWith("que_")
    expect(Pty.ID.create()).toStartWith("pty_")
  })

  test("skill IDs and digests enforce their exact opaque format", () => {
    const decodeID = Schema.decodeUnknownSync(Skill.ID)
    const decodeDigest = Schema.decodeUnknownSync(Skill.Digest)
    const digest = "a".repeat(64)

    expect(String(decodeID(`skl_${digest}` as unknown))).toBe(`skl_${digest}`)
    expect(String(decodeDigest(digest as unknown))).toBe(digest)
    expect(() => decodeID(`skl_${"a".repeat(63)}` as unknown)).toThrow()
    expect(() => decodeID(`skill_${digest}` as unknown)).toThrow()
  })

  test("skill target scopes use stable target identities and preserve explicit disabled state", () => {
    const decode = Schema.decodeUnknownSync(Skill.TargetScope)
    const targetID = "9a858c60-01c7-4a3d-a137-f5df09560d42"

    expect(decode("*")).toBe("*")
    expect(decode([])).toEqual([])
    const selected = decode(["local", targetID])
    expect(selected === "*" ? selected : selected.map(String)).toEqual(["local", targetID])
    expect(() => decode(["mywindows"])).toThrow()
  })

  test("reusable public identifiers are stable and unique", () => {
    const identifiers = [
      Agent.Color,
      FileSystem.Submatch,
      Model.Ref,
      Model.Capabilities,
      Model.Cost,
      Model.Api,
      Project.Icon,
      Project.Commands,
      Project.Time,
      Project.Info,
      Pty.Info,
      Session.ListAnchor,
      Skill.Metadata,
      Skill.SourceDetail,
      Skill.Diagnostic,
      Skill.RegistrySnapshot,
      Skill.Target,
      Skill.TargetScope,
      Skill.DiscoveryRoot,
      Skill.SettingsDiagnostic,
      Skill.SettingsSnapshot,
      Skill.DiscoveryUpdate,
      Skill.TargetScopeUpdate,
      Skill.RevisionInput,
    ].map((schema) => schema.ast.annotations?.identifier)

    expect(identifiers.every((identifier) => typeof identifier === "string")).toBe(true)
    expect(new Set(identifiers).size).toBe(identifiers.length)
  })

  test("current source avoids Any and mutable contract wrappers", async () => {
    const files = [...new Bun.Glob("*.ts").scanSync(new URL("../src", import.meta.url).pathname)].filter(
      (file) => !file.endsWith("-v1.ts"),
    )
    const source = await Promise.all(
      files.map((file) => Bun.file(new URL(`../src/${file}`, import.meta.url)).text()),
    ).then((values) => values.join("\n"))

    expect(source).not.toContain("Schema.Any")
    expect(source).not.toContain("Schema.mutable")
  })
})
