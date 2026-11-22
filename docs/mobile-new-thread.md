# 手机新会话草稿

从会话页右上角、菜单的「新会话」或项目行的加号打开草稿。选择已有项目、可用 Agent 实例、模型和权限，输入第一条消息后发送。项目入口会选中该项目。Host 给出默认实例和各实例的默认模型及权限。 [方案 D](../apps/mobile/DESIGN.md)

草稿按电脑和配对设备保存在手机的系统安全存储。切换项目和 Agent 实例时，输入中的文字可以继续编辑。Host 拒绝首发时可修改原文或重新选择设置。结果待确认时可查询回执，也可用原编号和原参数重试。首发被受理后，手机打开创建的会话，后续消息沿用会话保存的设置。 [DSH Go 草稿保存与恢复](https://github.com/ccch1mneyyy/dsh-Go/blob/a57078e842850793f1733ebd23f730a01d714e86/app/lib/state/draft_store.dart)

## 协议

双方协商 `draft.write` 后开放以下方法。模型目录按当前 Agent 实例查询，选择器只收到用于展示和提交的字段。

| 方法                  | 手机提交                                     | Host 返回                        |
| --------------------- | -------------------------------------------- | -------------------------------- |
| `thread.draftOptions` | 空对象                                       | 可用实例、各自可选的权限和默认值 |
| `thread.draftModels`  | 实例 ID                                      | 可选模型和默认模型               |
| `thread.create`       | 命令编号、项目、实例、模型、权限、首条纯文本 | 会话 ID、会话标题和第一轮 run ID |
| `command.receipt`     | 命令编号                                     | 同一身份下保留的首发结果         |

Host 在事务内登记会话、消息、run 和回执，提交后才启动 Agent。同一个命令编号绑定原项目、实例、模型、权限和正文。未通过发送校验或写入失败时，手机保有草稿。

## 复验

在前端仓库运行以下命令。跨端验收用本机 Go 中继，TS 和 Dart 进程都加载测试 CA。 [本机 Go 回环](./mobile-pairing.md#本机-go-回环)

```sh
node apps/desktop/scripts/generate-mobile-contracts.ts --check
pnpm exec vitest run apps/host/src/mobile/drafts.test.ts
(cd apps/mobile/app && flutter test test/new_thread_draft_test.dart)
```

回环核对首发前的空列表、事务失败后的无残留、同编号重复提交、断线丢回执后找回原会话、后续发送沿用已选设置，以及 Host 重启后查回执。Flutter 测试还覆盖草稿跨页面保留、失败恢复和收回执后打开新会话。

在 `apps/mobile` 构建本地验收包。

```sh
flutter pub get --enforce-lockfile
PIGCODE_MOBILE_BUILD_NUMBER=7 ./scripts/flutter-app.sh build ios --simulator --debug --no-pub
PIGCODE_MOBILE_BUILD_NUMBER=7 ./scripts/flutter-app.sh build apk --debug --no-pub
```

手动复验可在手机为一个已有项目打开草稿，选好实例、模型和权限，此时桌面列表仍只包含原有会话。发出第一条纯文本后，两端核对新会话、第一轮输出与后续回复。也可在电脑停用已经选好的实例，再从手机发送，核对失败提示、原文和待调整的设置。
