# 手机发消息与停止运行

打开已经配对的电脑，在会话里输入纯文本并点发送。Host 使用该会话当前的 Agent 实例、模型和权限。正在运行或已排队时，输入区的按钮可停止当前这轮。终态会同步到手机和桌面的时间线。输入区使用方案 D 的布局，键盘出现时随会话一起调整可用高度。 [手机端设计](../apps/mobile/DESIGN.md)

发送或停止后如果没收到回执，手机保留该次操作。恢复连接并打开该会话时，手机先查回执。已受理时会恢复原结果。仍待确认时，可点「查回执」或点「用原编号重试」，重试使用已保存的原文或原 run。移除电脑会清除此电脑的待确认操作。重试行为沿用 DSH Go 的请求编号。 [DSH Go 发送重试](https://github.com/ccch1mneyyy/dsh-Go/blob/a57078e842850793f1733ebd23f730a01d714e86/app/lib/state/chat_state.dart#L1317-L1347)

## 协议

双方协商到 `run.write` 后开放三个方法。尚未提供该能力的桌面仍可使用已有的只读功能。

| 方法              | 手机提交                                                        | Host 返回               |
| ----------------- | --------------------------------------------------------------- | ----------------------- |
| `run.start`       | `commandId`、会话 ID 和纯文本（最多 10,000 个 UTF-16 代码单元） | 受理回执和 run ID       |
| `run.interrupt`   | `commandId`、会话 ID 和 run ID                                  | 指定 run 的停止受理回执 |
| `command.receipt` | `commandId`                                                     | 原回执，未受理时为空    |

Host 以已认证的配对身份和 `commandId` 为回执键，并校验原方法和参数。发送把消息、run 与回执一次写入 SQLite，再启动 Agent。停止按会话核对 run 归属，一次写入停止状态、时间线事件和回执。回执在 Host 重启后仍可查询，run 的最终执行结果以共享时间线为准。

## 复验

按配对文档启动本机 Go 中继，设置 TS 和 Dart 的测试 CA、测试中继地址与令牌。在 `pigcode/pigcode` 运行下面的命令。 [本机 Go 回环](./mobile-pairing.md#本机-go-回环)

```sh
node apps/desktop/scripts/generate-mobile-contracts.ts --check
pnpm exec vitest run apps/host/src/mobile/run-commands.test.ts
(cd apps/mobile/app && flutter test test/run_composer_test.dart)
```

回环会在 Host 已受理、Dart 客户端还没收到回执时断开连接。它验证同编号重试只受理一次、发送沿用会话的 Agent 配置、手机收到 fake Agent 回复，以及两端得到同一个 run 的中断结果。测试还覆盖启动时停止、停止落盘失败后用原编号重试、Host 重启后查回执，以及撤销设备时取消其排队的 run。

在 `apps/mobile` 构建本地验收包，构建号可按设备上的已安装版本调整。

```sh
flutter pub get --enforce-lockfile
PIGCODE_MOBILE_BUILD_NUMBER=5 ./scripts/flutter-app.sh build ios --simulator --debug --no-pub
PIGCODE_MOBILE_BUILD_NUMBER=5 ./scripts/flutter-app.sh build apk --debug --no-pub
```

验收时在电脑和手机打开同一条会话。用手机发一条纯文本，检查两端的消息和回答。选择正在输出的一轮，点手机输入区的停止按钮，等待两端显示同一结果。弱网验收可在发送后切网，恢复连接后打开原会话，核对回执恢复和原编号重试。 [配对与签名步骤](./mobile-pairing.md)
