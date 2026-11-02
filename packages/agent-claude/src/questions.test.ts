/** 验证 AskUserQuestion 的输入解析与回答记录。 */
import { describe, expect, it } from "vitest"
import { answerRecord, parseQuestions } from "./questions"

describe("AskUserQuestion", () => {
  it("parse AskUserQuestion input and build Claude's answer record", () => {
    const questions = parseQuestions({
      questions: [
        {
          question: "用哪个包管理器？",
          header: "工具",
          multiSelect: false,
          options: [{ label: "pnpm", description: "仓库在用" }, { label: "" }, { label: "npm" }],
        },
        { question: "要哪些检查？", multiSelect: true, options: [] },
      ],
    })
    expect(questions).toEqual([
      {
        question: "用哪个包管理器？",
        header: "工具",
        multiSelect: false,
        options: [{ label: "pnpm", description: "仓库在用" }, { label: "npm" }],
      },
      { question: "要哪些检查？", multiSelect: true, options: [] },
    ])
    expect(parseQuestions({ questions: [{ header: "x" }] })).toBeNull()
    expect(parseQuestions({})).toBeNull()
    expect(answerRecord(questions!, ["pnpm", " "])).toEqual({ "用哪个包管理器？": "pnpm" })
  })
})
