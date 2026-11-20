import {
  configChoices,
  parseCliObject,
  selectConfig,
  type NativeAcpDefinition,
} from "@pigcode/acp-runtime"

export const fx: NativeAcpDefinition = {
  id: "fx",
  name: "fx",
  command: "fx",
  args: () => ["acp"],
  async account(run) {
    const { auth } = parseCliObject((await run(["status", "--json"])).text)
    return typeof auth === "string"
      ? { authenticated: auth !== "missing", account: auth === "missing" ? null : auth }
      : { authenticated: null }
  },
  async models(run) {
    const [status, list] = await Promise.all([run(["status", "--json"]), run(["models", "--json"])])
    const current = parseCliObject(status.text).model
    const ids = parseCliObject(list.text).ids
    const names = new Set<string>()
    if (typeof current === "string" && current) names.add(current)
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string" && id) names.add(id)
    return [...names].map((id) => ({
      id,
      displayName: id,
      isDefault: id === current,
      efforts: ["auto", "low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
    }))
  },
  protocol: {
    effortId: "effort",
    sessionMeta: { fx: { profileMcpServers: true } },
    approvalMode: () => "approval-required",
    sessionPolicy(setup, mode) {
      const config = selectConfig(setup.configOptions ?? [], "mode")
      const choices = config
        ? configChoices(config).map((option) => option.value)
        : (setup.modes?.availableModes.map((option) => option.id) ?? [])
      const value =
        mode === "auto"
          ? ["auto", "code"].find((choice) => choices.includes(choice))
          : choices.includes("ask")
            ? "ask"
            : undefined
      if (!value) throw new Error("fx did not advertise its requested permission mode")
      return { id: "mode", value }
    },
  },
}
