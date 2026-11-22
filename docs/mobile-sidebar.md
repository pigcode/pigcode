# 手机端项目与会话侧栏

连上已配对的电脑后，手机打开最近更新的未归档会话。点左上角打开方案 D 的菜单，可按项目浏览、折叠项目、搜索名称，或切换「需要处理」和「已归档」筛选。选中会话后回到它的状态页。侧栏底部的电脑按钮可以切换连接。断线时显示本次连接最后同步的列表和时间，隐藏旧状态标记。

## Host 与手机的契约

手机通过身份验证和版本协商后，调用 `project.list`、`thread.list` 和 `sidebar.subscribe`。项目只有 `id` 与 `name`。会话只包含侧栏所需字段，按更新时间倒序读取，支持可选项目范围。分页使用 `offset` 和 `limit`。每次用已收集的条数作为下次偏移，直到收到空数组。窗口的完整项目记录沿用本机 RPC。

订阅收到 `sidebar.changed` 后会刷新摘要。即使分页期间发生变化，手机也会重新读取后再提交新快照。窗口和各手机从同一个 Host 状态收更新，关闭某条连接只释放该连接的订阅。未开放的方法返回 `METHOD_NOT_AVAILABLE`，参数不符合手机契约时返回 `INVALID_PARAMS`。

会话摘要预留置顶字段，Host 的置顶写入由后续工单接入。会话时间线由下一张工单接入。[桌面端会话置顶](https://github.com/pigcode/monorepo/issues/108) · [同步置顶、归档和未读](https://github.com/pigcode/monorepo/issues/123) · [手机时间线](https://github.com/pigcode/monorepo/issues/116)

## 验收

从 Zod 导出 JSON Schema 后生成 Dart 类型。CI 检查生成结果，TS 与 Dart 使用同一组请求、结果和事件样例。

```sh
node apps/desktop/scripts/generate-mobile-contracts.ts --check
pnpm exec vitest run packages/contracts/src/mobile-sidebar.test.ts
(cd apps/mobile/packages/pigcode_client && dart test)
(cd apps/mobile/app && flutter test test/workspace_test.dart)
```

启动真实 Go 中继并设置本机测试 CA、地址和令牌。下面的命令让两个 Dart 客户端经中继配对、读取超过一页的列表，同时由窗口连接修改项目和启动 fake Agent。两部手机应看到最新项目名、会话状态和未读，断开其中一部后另一部仍接收更新。[本机 Go 中继配置](./mobile-pairing.md#本机-go-回环)

```sh
pnpm exec vitest run apps/host/src/rpc/mobile-sidebar.test.ts
```

用模拟器或在 iPhone 上配对后连接电脑。核对最近会话、项目分组、筛选和单一状态标记。在桌面改项目名或启动会话，保持手机菜单打开，核对两端结果。断开手机网络后核对连接提示与上次同步时间。[构建和签名步骤](./mobile-pairing.md)
