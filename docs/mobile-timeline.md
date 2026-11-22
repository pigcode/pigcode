# 手机会话时间线

从方案 D 菜单打开一条会话，手机先显示最近两轮和正在运行的正文。上翻到列表顶部可读取更早消息，已在读的内容留在原位置。贴近底部时跟随新输出，手动上翻后可以点「回到底部」。正常结束的轮次把过程收在「用时」一行，最后的回答留在时间线上。活动条显示当前步骤、用时和计划进度。

工具参数和输出初始分别最多显示 512 个字符。点工具行打开详情，再分段读取完整内容。超长正文可从该条回答打开。回环测试使用固定数据，工具详情和正文都按所选会话及事件或正在运行的轮次读取。

## 协议

- `thread.subscribe` 的首屏带历史窗口和当前运行快照。历史游标固定在这次订阅的 `through`，`thread.history` 用排除式 `before` 取更早记录。历史页以至少 50 条显示事件和两轮为目标，最多扫描 500 条事件，并遵守 256 KiB 的未压缩响应预算。单轮过大时仍按同一 run 合并。
- `thread.event` 带上一个已发送的会话事件序号。全库正常跳号不影响合并。当前运行快照带 `revision`，`thread.delta` 追加正文、思考和工具输出。增量缺片时只重取当前运行快照，已打开的历史与上翻位置保留。窗口使用同一 Host 实时通道。退出一个会话订阅时只释放该连接的监听。
- `thread.content` 按事件序号或当前 run 分段读正文、工具参数及工具输出。返回的 `nextOffset` 用于下一段。Host 核对会话及记录的归属。
- 大页面在 Noise 上分为有序帧。每片加密前使用 1 字节零标记、4 字节大端总长和 4 字节大端偏移，整条消息的组装上限是 256 KiB 加 1 KiB。小消息继续用现有 JSON 帧。

## 复验

在前端仓库运行契约与分组测试。共享夹具由桌面 TS 和 Dart 分别解析。

```sh
node apps/desktop/scripts/generate-mobile-contracts.ts --check
pnpm exec vitest run packages/ui-chat/src/mobile-timeline-parity.test.ts
(cd apps/mobile/packages/pigcode_client && dart test test/timeline_turns_test.dart)
(cd apps/mobile/app && flutter test test/timeline_view_test.dart)
```

启动本机 Go 中继并设置测试 CA、地址和令牌。Host 测试会先从桌面发起一轮受控输出，再让 Dart 手机中途订阅，验证大首屏分片、正文续接、向前补页和完整工具输出。[本机 Go 中继配置](./mobile-pairing.md#本机-go-回环)

```sh
pnpm exec vitest run apps/host/src/mobile/timeline.test.ts
```

真机复验可用一段长会话从桌面开始运行，中途在手机打开。核对已输出的正文、后续增量、活动条与终态，再手动上翻加载历史并回到底部。[构建与签名步骤](./mobile-pairing.md)
