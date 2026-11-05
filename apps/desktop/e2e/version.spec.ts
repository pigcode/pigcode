/** 设置页显示的版本来自 package.json，经过主进程和 preload 送到界面（adr/0007）。 */
import { readFileSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { openThread } from "./projects"

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  .version as string

test("the settings page shows the version the app was built with", async () => {
  const { app, page } = await openThread("version")
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await expect(page.getByText(`当前版本 ${version}`)).toBeVisible()
  await app.close()
})
