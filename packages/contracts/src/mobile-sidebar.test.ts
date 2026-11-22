import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import {
  mobileProjectListParamsSchema,
  mobileProjectListResultSchema,
  mobileRpcErrorSchema,
  mobileSidebarChangedSchema,
  mobileSidebarSubscribeParamsSchema,
  mobileSidebarSubscribeResultSchema,
  mobileThreadListParamsSchema,
  mobileThreadListResultSchema,
} from "./mobile-sidebar"

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/mobile-sidebar-v1.json", import.meta.url), "utf8"),
)

it("parses the same sidebar contract examples as the Dart client", () => {
  expect(mobileProjectListParamsSchema.parse(fixture.projectList.params)).toEqual(
    fixture.projectList.params,
  )
  expect(mobileProjectListResultSchema.parse(fixture.projectList.result)).toEqual(
    fixture.projectList.result,
  )
  expect(mobileThreadListParamsSchema.parse(fixture.threadList.params)).toEqual(
    fixture.threadList.params,
  )
  expect(mobileThreadListResultSchema.parse(fixture.threadList.result)).toEqual(
    fixture.threadList.result,
  )
  expect(mobileSidebarSubscribeParamsSchema.parse(fixture.subscribe.params)).toEqual(
    fixture.subscribe.params,
  )
  expect(mobileSidebarSubscribeResultSchema.parse(fixture.subscribe.result)).toEqual(
    fixture.subscribe.result,
  )
  expect(mobileSidebarChangedSchema.parse(fixture.changed)).toEqual(fixture.changed)
  expect(mobileRpcErrorSchema.parse(fixture.problem)).toEqual(fixture.problem)
})

it("rejects out-of-bounds paging and project details outside the mobile projection", () => {
  expect(mobileThreadListParamsSchema.safeParse({ limit: 65 }).success).toBe(false)
  const result = [{ id: "pr_1", name: "工作台", rootPath: "/private" }]
  expect(mobileProjectListResultSchema.safeParse(result).success).toBe(false)
})
