import { describe, expect, test } from "bun:test"
import {
  sessionLocationNotice,
  sessionLocationNoticeKey,
  sessionLocationNoticeText,
} from "../../src/util/session-location-notice"

describe("Session Location changed notice", () => {
  test("is keyed per Session and keeps the durable revision and both Locations", () => {
    const notice = sessionLocationNotice({
      revision: 4,
      previous: { directory: "/old" },
      location: {
        target: { type: "rexd", targetID: "target-id" },
        directory: "/new",
        lastKnownTargetName: "gpu",
      },
    })
    expect(sessionLocationNoticeKey("ses_one")).toBe("session_location_changed:ses_one")
    expect(notice).toEqual({
      revision: 4,
      previous: { directory: "/old" },
      location: {
        target: { type: "rexd", targetID: "target-id" },
        directory: "/new",
        lastKnownTargetName: "gpu",
      },
    })
    expect(sessionLocationNoticeText(notice)).toBe("Location changed · gpu · /new")
  })
})
