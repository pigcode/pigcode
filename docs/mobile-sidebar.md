# 手机端项目与会话侧栏

连上已配对的电脑后，手机打开最近更新的未归档会话。点左上角打开方案 D 的菜单，可折叠项目、搜索项目与会话、切换侧栏分组和排序，或筛选「需要处理」和「已归档」。置顶会话排在顶部，只出现一次。选中会话后回到它的状态页。侧栏底部的电脑按钮可以切换连接。断线时显示最后同步的列表和时间，隐藏旧状态标记。

在线时长按会话可切换置顶、标为已读或未读、归档或取消归档。归档会同时取消置顶。「分组和筛选」里可以把所有未读会话标为已读。等待审批或回答的会话继续留在「需要处理」。 [方案 D](https://github.com/pigcode/monorepo/issues/94#issuecomment-7064526109)

## Host 与手机的契约

手机通过身份验证和版本协商后，调用 `project.list`、`thread.list` 和 `sidebar.subscribe`。项目只有 `id` 与 `name`。会话只包含侧栏所需字段，按更新时间倒序读取，支持可选项目范围。分页使用 `offset` 和 `limit`。每次用已收集的条数作为下次偏移，直到收到空数组。窗口的完整项目记录沿用本机 RPC。

订阅收到 `sidebar.changed` 后会刷新摘要。即使分页期间发生变化，手机也会重新读取后再提交新快照。窗口和各手机从同一个 Host 状态收更新，关闭某条连接只释放该连接的订阅。未开放的方法返回 `METHOD_NOT_AVAILABLE`，参数不符合手机契约时返回 `INVALID_PARAMS`。

设备协商 `sidebar.write` 后，通过同一配对连接调用 `thread.setPinned`、`thread.archive`、`thread.unarchive`、`thread.markRead` 和 `thread.markAllRead`。Host 校验配对授权和会话范围，然后更新两端共用的记录。 [置顶数据](https://github.com/pigcode/monorepo/issues/108) · [侧栏操作](https://github.com/pigcode/monorepo/issues/123)

Host 为最新结束的 run 提供 `readTarget`，并报告最近一次手动标未读的轮次与版本。桌面或手机在前台显示相应终态时，记下当时看到的版本，通过 `thread.acknowledgeRead` 确认。迟到回执只在轮次和版本仍一致时生效。手动标未读后，重新进入会话或看到新结果才会再次自动确认。 [多端未读规则](https://github.com/pigcode/monorepo/issues/93#issuecomment-7073510830)

## 验收

从 Zod 导出 JSON Schema 后生成 Dart 类型。CI 检查生成结果，TS 与 Dart 使用同一组请求、结果和事件样例。

```sh
node apps/desktop/scripts/generate-mobile-contracts.ts --check
pnpm exec vitest run packages/contracts/src/mobile-sidebar.test.ts apps/host/src/rpc/thread-read-target.test.ts apps/desktop/src/renderer/src/thread-reading.test.tsx
(cd apps/mobile/packages/pigcode_client && dart test)
(cd apps/mobile/app && flutter test test/workspace_test.dart test/thread_read_receipt_test.dart)
```

启动真实 Go 中继并设置本机测试 CA、地址和令牌。下面的命令让两个 Dart 客户端经中继配对、读取超过一页的列表。验证手机置顶后桌面能读到状态，手机确认已读后桌面同步，手动标未读能挡住旧回执，以及全部标已读后审批、提问仍显示为待处理。断开一部手机后另一部仍接收 Host 更新。 [本机 Go 中继配置](./mobile-pairing.md#本机-go-回环)

```sh
pnpm exec vitest run apps/host/src/rpc/mobile-sidebar.test.ts
```

用模拟器或在 iPhone 上配对后连接电脑。切换项目、更新时间和状态分组，核对置顶段、搜索和单一状态标记。长按置顶并归档，再从「已归档」恢复。让一次 run 在隐藏窗口或手机未打开会话时结束，核对未读保留。前台打开且加载完结果后，核对另一端自动更新。断开手机网络后，核对缓存时间与只读侧栏。 [构建和签名步骤](./mobile-pairing.md)

2026-11-23，产品版本 `0.1.0-beta.5` 的构建 `14` 已安装并启动于 iOS 26.0 和 Android 16 模拟器。SQLite v14 迁移、两个 Dart 客户端的 Go WSS 回环、4 项桌面定向端到端测试和 48 项 Flutter 应用测试通过。
