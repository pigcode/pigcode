/** 主机配对、身份与远程目录浏览相关的 RPC 分发处理。 */
import { hostname } from "node:os"
import type { Context } from "cordis"
import type { CommandMethod, CommandParams } from "@pigcode/contracts"
import { browseHostDirectories } from "../services/browse-dirs"

export const HOST_COMMANDS = new Set<CommandMethod>([
  "mobile.pairing",
  "mobile.pairing.start",
  "mobile.pairing.cancel",
  "mobile.pairing.confirm",
  "mobile.devices.revoke",
  "desktop.pairing",
  "desktop.pairing.start",
  "desktop.pairing.cancel",
  "desktop.pairing.confirm",
  "desktop.devices.revoke",
  "host.identity",
  "host.setName",
  "host.browseDirs",
])

/** 执行已校验参数的主机管理与配对 RPC 命令。 */
export async function dispatchHostCommand(
  ctx: Context,
  command: CommandMethod,
  parsed: unknown,
): Promise<unknown> {
  switch (command) {
    case "mobile.pairing":
      return ctx.mobileConnections.view()
    case "mobile.pairing.start":
      return ctx.mobileConnections.start()
    case "mobile.pairing.cancel":
      return ctx.mobileConnections.cancel((parsed as CommandParams<"mobile.pairing.cancel">).id)
    case "mobile.pairing.confirm": {
      const { id, confirmation } = parsed as CommandParams<"mobile.pairing.confirm">
      return ctx.mobileConnections.confirm(id, confirmation)
    }
    case "mobile.devices.revoke":
      return ctx.mobileConnections.revoke(
        (parsed as CommandParams<"mobile.devices.revoke">).deviceId,
      )
    case "desktop.pairing":
      return ctx.mobileConnections.desktopView()
    case "desktop.pairing.start":
      return ctx.mobileConnections.startDesktopPairing()
    case "desktop.pairing.cancel":
      return ctx.mobileConnections.cancelDesktopPairing(
        (parsed as CommandParams<"desktop.pairing.cancel">).id,
      )
    case "desktop.pairing.confirm": {
      const { id, confirmation } = parsed as CommandParams<"desktop.pairing.confirm">
      return ctx.mobileConnections.confirmDesktopPairing(id, confirmation)
    }
    case "desktop.devices.revoke":
      return ctx.mobileConnections.revokeDesktop(
        (parsed as CommandParams<"desktop.devices.revoke">).deviceId,
      )
    case "host.identity": {
      const connections = ctx.get("mobileConnections")
      if (connections) {
        const identity = await connections.hostIdentity()
        return {
          hostKey: identity.hostKey,
          hostName: identity.hostName,
          runtime: process.versions.electron ? ("desktop" as const) : ("headless" as const),
        }
      }
      const savedName = ctx.settings.get("host.name")
      const hostName =
        typeof savedName === "string" && savedName.trim()
          ? savedName.trim().slice(0, 80)
          : hostname().split(".")[0]?.slice(0, 80) || "Pigcode"
      return {
        hostKey: "0".repeat(43),
        hostName,
        runtime: process.versions.electron ? ("desktop" as const) : ("headless" as const),
      }
    }
    case "host.setName": {
      const { name } = parsed as CommandParams<"host.setName">
      const connections = ctx.get("mobileConnections")
      const hostName = connections
        ? connections.setHostName(name)
        : (() => {
            ctx.settings.set("host.name", name)
            return name
          })()
      return { hostName }
    }
    case "host.browseDirs": {
      const { path } = parsed as CommandParams<"host.browseDirs">
      return browseHostDirectories(path)
    }
    default:
      throw new Error(`unsupported host command: ${command}`)
  }
}
