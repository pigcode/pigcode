# 手机处理审批和提问

当 Agent 等待审批或回答时，手机会话的输入区显示待处理面板。审批按钮来自 Host 提供的选项。提问按原来的顺序显示单选、多选及允许填写的「其他」。一项处理结束后显示下一项，最后一项结束后恢复原输入框。 [方案 D 视觉规范](../apps/mobile/DESIGN.md)

Host 保存首个有效处理及其来源，窗口与手机的时间线显示生效的决定或回答。另一端接着提交时，界面显示已经生效的结果。停止 run 会让它剩余的请求失效。结果未确认时，重连先查回执，手动重试沿用原命令编号和提交内容。 [多端行为决策](https://github.com/pigcode/monorepo/issues/93#issuecomment-7073510830) · [DSH Go 请求编号重试](https://github.com/ccch1mneyyy/dsh-Go/blob/a57078e842850793f1733ebd23f730a01d714e86/app/lib/state/chat_state.dart#L1317-L1347)

## 协议

双方协商 `request.write` 后，手机按时间线中的待处理请求 ID 调用下列方法。每次操作校验配对身份、会话、run 和请求的归属。审批校验可选决议，提问校验题目顺序、选项和自定义回答的许可。

| 方法                  | 用途                                 |
| --------------------- | ------------------------------------ |
| `request.details`     | 读取仍待处理的审批内容或问题表单     |
| `run.respondApproval` | 提交一个获准的决议                   |
| `run.answerQuestion`  | 按每题提交选中的选项及可选自定义回答 |
| `command.receipt`     | 查询同一身份、同一编号的原受理结果   |

回复包括请求 ID、run ID 和处理结果，可表示本次生效、此前已处理或已失效。Host 在同一 SQLite 事务中保存生效的结果、时间线事件和命令回执，提交成功后再让 Agent 继续。

手机提交答案的 UTF-8 编码上限为 48 KiB。窗口提交的答案过长时，手机回执显示带标记的部分内容，完整结果可在桌面查看。

## 复验

按配对文档运行本机 Go 中继，给 TS 和 Dart 验收进程配置测试 CA、地址和令牌。在前端仓库执行以下命令。 [本机 Go 回环](./mobile-pairing.md#本机-go-回环)

```sh
node apps/desktop/scripts/generate-mobile-contracts.ts --check
pnpm exec vitest run apps/host/src/mobile/requests.test.ts apps/host/src/rpc/approval.test.ts apps/host/src/rpc/questions.test.ts
(cd apps/mobile/app && flutter test test/request_input_test.dart)
```

回环从桌面发起一轮 fake Agent，让手机看到同一轮的审批和提问。窗口先处理审批，手机随后提交不同决议并看到窗口的结果。然后让手机先回答，窗口取得同一份答案。还验证了命令编号去重、回执落盘失败时保留待处理请求、停止后失效和 Host 重启后查询原回执。

在 `apps/mobile` 构建本地验收包。

```sh
flutter pub get --enforce-lockfile
PIGCODE_MOBILE_BUILD_NUMBER=6 ./scripts/flutter-app.sh build ios --simulator --debug --no-pub
PIGCODE_MOBILE_BUILD_NUMBER=6 ./scripts/flutter-app.sh build apk --debug --no-pub
```

手动复验时，用 fake Agent 从桌面发 `approve` 或 `ask`，并在手机打开同一会话。分别从手机处理审批和回答提问，核对两端结果与输入区恢复。再从桌面先处理同一请求，检查手机里的卡片收起和实际结果。
