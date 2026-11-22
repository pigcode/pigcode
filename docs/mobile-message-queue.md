# 窗口和手机共享待发队列

同一会话的消息由 Host 按受理顺序登记。会话空闲时，首条消息开始 run。运行中发出的消息进入待发队列，在窗口和手机的输入区附近显示。正常完成后，Host 继续发送队首。 [DSH Go 共享待发消息](https://github.com/ccch1mneyyy/dsh-Go/blob/a57078e842850793f1733ebd23f730a01d714e86/app/lib/state/chat_state.dart#L1244-L1283)

「撤回」将原文加回发起端的草稿。一个待发条目在撤回或开始发送后，另一端会更新队列。「停止并发送」要求指定待发消息及当前 run，Host 核对两者，等旧 Agent 调用清理完毕后再启动选中的消息。

普通停止、失败或 Host 重启后，队列保留并暂停。暂停时仍可提交新消息，点「继续发送」后从队首恢复。撤销手机会取消它仍未启动的待发消息、排队中的 run 和它安排的续发操作。执行前 Host 会再次核对配对授权。 [多端行为决策](https://github.com/pigcode/monorepo/issues/93#issuecomment-7073510830)

## 协议

双方协商 `queue.write` 后开放以下手机方法。队列随会话事件刷新。

| 方法                | 行为                                   |
| ------------------- | -------------------------------------- |
| `run.start`         | 判定消息立即开始还是进入同一会话的队列 |
| `queue.get`         | 读取队列、暂停状态和当前 run           |
| `queue.withdraw`    | 撤回指定条目并返回原文                 |
| `queue.stopAndSend` | 核对当前 run 并安排指定条目            |
| `queue.resume`      | 从暂停的队首恢复                       |
| `command.receipt`   | 查回同一命令编号对应的原结果           |

命令回执和队列状态一起保存。窗口和手机遇到发送结果不明时会先查回执，仍待确认时可用原编号重试。队列按会话最多保留 64 条待发消息，桌面加入队列的单条正文最多 32,000 个 UTF-16 代码单元，以便手机能完整取回撤回的文字。

## 复验

按配对文档启动本机 Go 中继，给 TS 和 Dart 验收进程配置测试 CA、地址及令牌。在前端仓库运行以下命令。 [本机 Go 回环](./mobile-pairing.md#本机-go-回环)

```sh
node apps/desktop/scripts/generate-mobile-contracts.ts --check
pnpm exec vitest run apps/host/src/mobile/queued-messages.test.ts
pnpm --dir apps/desktop exec playwright test e2e/queued-messages.spec.ts
(cd apps/mobile/app && flutter test test/message_queue_test.dart)
```

回环验证两端入队和续发顺序、撤回原文、重复操作的稳定回执、对旧 run 的停止拒绝、失败停止及重启后的保留和恢复，还有撤销设备后的清理。Flutter 测试验证运行中发送和把撤回内容交回发起端的输入框。

在 `apps/mobile` 构建本地验收包。

```sh
flutter pub get --enforce-lockfile
PIGCODE_MOBILE_BUILD_NUMBER=8 ./scripts/flutter-app.sh build ios --simulator --debug --no-pub
PIGCODE_MOBILE_BUILD_NUMBER=8 ./scripts/flutter-app.sh build apk --debug --no-pub
```

手动复验可在桌面发 `long` 让 fake Agent 保持运行。两端各发一条待发消息，核对队列顺序。先从手机撤回一条，再用「停止并发送」处理选中的消息。另发一轮后做普通停止，检查剩余队列保留、暂停与继续。
