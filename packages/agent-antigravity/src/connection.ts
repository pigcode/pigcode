import {
  openAcp as openConnection,
  type AcpConnectionOptions,
  type AcpLaunch,
} from "@pigcode/acp-runtime"

export { requestOptions } from "@pigcode/acp-runtime"

export const antigravityConnection: AcpConnectionOptions = {
  name: "Antigravity CLI",
  validate(reply) {
    if (
      !reply.agentCapabilities?.sessionCapabilities?.resume ||
      !reply.agentCapabilities.auth?.logout
    )
      throw new Error("Update Antigravity CLI to a version supporting native resume and sign-out")
  },
}

export function openAcp(launch: AcpLaunch) {
  return openConnection(launch, {}, antigravityConnection)
}
