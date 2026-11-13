import { agentExecutionModesSchema } from "@pigcode/contracts"
import fixture from "./fixtures/permissions.json"

/** 测试显式提供插件声明，组件没有内置的通用权限列表。 */
export const TEST_MODES = agentExecutionModesSchema.parse(fixture)
