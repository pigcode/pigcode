import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { UserImageAttachment } from "@pigcode/plugin-sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { claudePrompt } from "./skill-prompt"

let root: string
let config: string
let cwd: string
let imgPath: string
const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
])

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pigcode-claude-prompt-")))
  config = join(root, "config")
  cwd = join(root, "workspace")
  imgPath = join(root, "shot.png")
  await writeFile(imgPath, pngBytes)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function sampleAttachment(): UserImageAttachment {
  return {
    id: "att_1",
    path: imgPath,
    mimeType: "image/png",
    fileName: "shot.png",
    sizeBytes: pngBytes.length,
    width: 1,
    height: 1,
  }
}

async function firstMessage(prompt: ReturnType<typeof claudePrompt>) {
  if (typeof prompt === "string") throw new Error("Expected AsyncIterable<SDKUserMessage>")
  const next = await prompt[Symbol.asyncIterator]().next()
  return next.value
}

describe("claudePrompt with image attachments", () => {
  it("streams base64 image block alone for image-only messages", async () => {
    const prompt = claudePrompt(
      { text: "", attachments: [sampleAttachment()] },
      { cwd, env: { CLAUDE_CONFIG_DIR: config } },
    )
    const msg = await firstMessage(prompt)
    expect(msg?.message.content).toEqual([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: pngBytes.toString("base64"),
        },
      },
    ])
  })

  it("places image blocks before text and handoff", async () => {
    const prompt = claudePrompt(
      { text: "explain this error", handoff: "prior context", attachments: [sampleAttachment()] },
      { cwd, env: { CLAUDE_CONFIG_DIR: config } },
    )
    const msg = await firstMessage(prompt)
    expect(msg?.message.content).toEqual([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: pngBytes.toString("base64"),
        },
      },
      { type: "text", text: "prior context\n\nexplain this error" },
    ])
  })

  it("places image blocks before skill expansion blocks so the last block still starts with /skill", async () => {
    await mkdir(join(config, "skills", "review-ui"), { recursive: true })
    await writeFile(join(config, "skills", "review-ui", "SKILL.md"), "---\nname: review-ui\n---\n")

    const prompt = claudePrompt(
      { text: "check this layout with $review-ui please", attachments: [sampleAttachment()] },
      { cwd, env: { CLAUDE_CONFIG_DIR: config } },
    )
    const msg = await firstMessage(prompt)
    expect(msg?.message.content).toEqual([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: pngBytes.toString("base64"),
        },
      },
      { type: "text", text: "check this layout with /review-ui please" },
      { type: "text", text: "/review-ui please" },
    ])
  })
})
