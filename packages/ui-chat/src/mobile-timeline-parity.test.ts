import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import { mobileTimelineEvent, type ThreadEvent } from "@pigcode/contracts"
import { buildTimeline } from "./turns"

it("groups the shared timeline fixture the same way as the Dart timeline", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../contracts/fixtures/mobile-timeline-v1.json", import.meta.url),
      "utf8",
    ),
  )
  const events: ThreadEvent[] = fixture.events.map((value: unknown) => {
    const event = mobileTimelineEvent.parse(value)
    const type =
      event.kind === "message.assistant" || event.kind === "message.user"
        ? "message.completed"
        : event.kind === "reasoning"
          ? "reasoning.completed"
          : event.kind
    return {
      seq: event.seq,
      threadId: "example",
      runId: event.runId ?? null,
      type: type as ThreadEvent["type"],
      schemaVersion: 1,
      createdAt: event.createdAt,
      payload: {
        role: event.kind === "message.user" ? "user" : "assistant",
        text: event.text,
        id: event.itemId,
        toolCallId: event.itemId,
        name: event.name,
        input: event.kind === "tool.started" ? event.text : undefined,
        output: event.kind === "tool.completed" ? event.text : undefined,
      },
    }
  })
  const group = buildTimeline(events).flatMap((entry) => {
    if (entry.kind !== "turn") return []
    const { turn } = entry
    return [
      {
        key: turn.key,
        user: turn.userText,
        work: turn.work.map(({ kind }) => kind),
        answer: turn.answer,
        status: turn.status,
        folded: turn.status === "completed" && turn.work.length > 0,
      },
    ]
  })
  expect(group).toEqual(fixture.turns)
})
