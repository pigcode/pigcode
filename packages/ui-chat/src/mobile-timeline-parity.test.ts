import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import { mobileTimelineEvent, type MobileTimelineEvent, type ThreadEvent } from "@pigcode/contracts"
import { groupSummaries, summaryCategory, summaryCounts, summaryIconItem } from "./summary-groups"
import { toolFamily } from "./tool-identity"
import { buildTimeline, type WorkItem } from "./turns"

function toThreadEvent(value: unknown): ThreadEvent {
  const event: MobileTimelineEvent = mobileTimelineEvent.parse(value)
  const type =
    event.kind === "message.assistant" || event.kind === "message.user"
      ? "message.completed"
      : event.kind === "reasoning"
        ? "reasoning.completed"
        : event.kind
  let input: unknown = event.kind === "tool.started" ? event.text : undefined
  if (typeof input === "string" && (input.startsWith("{") || input.startsWith("["))) {
    try {
      input = JSON.parse(input)
    } catch {
      // Keep raw string when truncated/plain.
    }
  }
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
      requestId: event.itemId,
      toolCallId: event.itemId,
      name: event.name,
      input,
      output: event.kind === "tool.completed" ? event.text : undefined,
      questions:
        event.kind === "question.requested"
          ? [{ question: event.text ?? "?", options: [] }]
          : undefined,
      answers: event.kind === "question.answered" ? [event.text ?? ""] : undefined,
    },
  }
}

function workItemTag(item: WorkItem): string {
  return item.kind === "tool" ? `tool:${item.tool.name}` : item.kind
}

function iconCategoryOf(items: readonly WorkItem[]): string | null {
  const chosen = summaryIconItem(items)
  if (!chosen || chosen.kind !== "tool") return null
  if (toolFamily(chosen.tool.name) === "browser") return "browser"
  return summaryCategory(chosen.tool)
}

it("groups the shared timeline fixture the same way as the Dart timeline", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../contracts/fixtures/mobile-timeline-v1.json", import.meta.url),
      "utf8",
    ),
  )
  const events: ThreadEvent[] = fixture.events.map(toThreadEvent)
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

it("merges tool chains in the shared summary-group fixture the same way as Dart", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../contracts/fixtures/timeline-summary-groups-v1.json", import.meta.url),
      "utf8",
    ),
  ) as { scenarios: Array<{ name: string; events: unknown[]; entries: unknown[] }> }

  for (const scenario of fixture.scenarios) {
    const turns = buildTimeline(scenario.events.map(toThreadEvent)).flatMap((entry) =>
      entry.kind === "turn" ? [entry.turn] : [],
    )
    expect(turns, scenario.name).toHaveLength(1)
    const entries = groupSummaries(turns[0]!.work).map((entry) =>
      entry.kind === "group"
        ? {
            kind: "group",
            items: entry.items.map(workItemTag),
            counts: summaryCounts(entry.items),
            iconCategory: iconCategoryOf(entry.items),
          }
        : { kind: "single", item: workItemTag(entry) },
    )
    expect(entries, scenario.name).toEqual(scenario.entries)
  }
})
