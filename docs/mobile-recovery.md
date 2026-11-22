# 手机恢复会话

[切网、睡眠和重启后恢复会话 #121](https://github.com/pigcode/monorepo/issues/121)

## 恢复顺序

1. 手机在前台切换网络、回到前台或连接断开时，使用保存的配对身份重新连接。每次恢复都读一次完整的项目与会话摘要。新摘要接管列表前，原列表和打开的时间线保持可读，写操作等新连接与读取完成。
2. 打开的会话从最后应用的持久事件游标续订。Host 返回补齐范围和当前运行快照，手机按同一范围向前翻页，按事件序号去重，再合并边界之后的推送。历史上翻仍使用原先的读取位置。游标无效时重新打开 Host 提供的当前窗口。 [同步决策 #92](https://github.com/pigcode/monorepo/issues/92) · [DSH Go 的续订和增量处理](https://github.com/ccch1mneyyy/dsh-Go/blob/a57078e842850793f1733ebd23f730a01d714e86/packages/dsh_client/lib/src/session_api.dart#L918-L1003)
3. 运行输出的 revision 出现缺口时，读取当前运行快照。Host 重启时先从数据库收尾中断的 run，挂起的审批和提问随新快照收起。手机重连后按原命令编号查受理回执。 [Host 重启场景 #84](https://github.com/pigcode/monorepo/issues/84)

新版 Host 和手机协商 `timeline.resume` 后使用 `thread.subscribe` 的 `after` 和 `thread.catchUp`。已有 `timeline.read` 的客户端仍可使用完整窗口和向上翻页。

## 电脑在线状态

手机另外用 `relay.watch` 订阅电脑状态。它与普通中继注册使用同一个令牌和电脑 ID。`relay.status` 带 `state` 和以毫秒表示的 `lastOnlineAt`，未见过的电脑返回 `offline` 和空时间。已连接的会话继续使用 Noise 保护的传输。 [共享中继消息夹具](../packages/contracts/fixtures/relay-route-v1.json) · [中继决策 #96](https://github.com/pigcode/monorepo/issues/96)

Go 中继和手机使用 WebSocket 心跳。Host 通过支持状态的中继协商 25 秒周期，并用 `relay.ping` 和 `relay.pong` 测量中继连接。两段心跳周期没有收到回应时判定连接断开。手机能区分电脑睡眠、Pigcode 退出、计划内重启、电脑离线和中继不可达。Go 用 `-status-file` 配置状态文件，systemd 默认使用 `/var/lib/pigcode-relay/computers.json`。中继重启后，在线状态由新注册确认，最后在线时间和已收到的明确状态从文件恢复。

桌面插电且有运行中或等待审批、回答的 run 时，自动防止空闲睡眠。合盖继续由系统处理。收到系统的休眠通知时，Host 尽力发送睡眠状态。手机若收不到该状态，会按心跳显示离线。 [Electron 电源事件](https://www.electronjs.org/docs/latest/api/power-monitor) · [Electron 防止空闲睡眠接口](https://www.electronjs.org/docs/latest/api/power-save-blocker)

## 回归验收

在 Go 中继仓库执行以下命令。状态恢复用测试临时目录。用于 Host 和 Dart 回环的本机 WSS 可按[本机 CA 步骤](mobile-pairing.md#本机-go-回环)启动。

~~~sh
go test -race ./...
go vet ./...
~~~

在前端仓库根目录运行以下命令，使用[本机 Go 回环](mobile-pairing.md#本机-go-回环)的 CA、地址和令牌环境变量。

~~~sh
pnpm exec vitest run apps/host/src/mobile/{recovery,relay-host,timeline}.test.ts \
  apps/host/src/rpc/host-activity.test.ts apps/desktop/src/main/keep-awake.test.ts
~~~

Go WSS 回环先让手机打开一个等待审批的会话，再模拟电脑休眠。手机在恢复后补齐 510 条持久事件，保留此前加载的历史和阅读位置。随后从停机清理前的 SQLite 副本启动 Host，检查新摘要的会话状态为已停止，时间线收到重启提示，未完成审批已收起。Dart 测试覆盖切网时迟到的连接结果、重复事件、缺失的运行 revision、回前台重新连接，以及侧栏读取失败后可在保留的会话上重试。

~~~sh
(cd apps/mobile && dart analyze --fatal-infos)
(cd apps/mobile/packages/pigcode_client && dart test)
(cd apps/mobile/app && flutter test)
~~~

## 设备复验

1. 让桌面 Host 连接新版 Go 中继，在手机配对并打开一个正在输出的会话，向上翻到较早的记录。把手机退到后台，待桌面追加输出后恢复。再在 Wi-Fi 和蜂窝之间切换一次。检查手机重新读取列表，新输出接续且没有重复。
2. 桌面插电时启动能持续输出的 run，观察系统空闲时电脑保持唤醒。拔掉电源，再观察系统空闲睡眠策略。系统休眠和唤醒可独立触发，手机应先显示睡眠或离线，再恢复会话。
3. 在关闭手动「保持唤醒」时实际合盖，观察手机显示睡眠或离线。重新开盖后检查同一会话恢复，再分别验证电脑端正常退出和计划重启的状态文案。

## 2026-11-23 验收记录

| 验收环境 | 结果 |
| --- | --- |
| 本机 Go WSS 与临时 SQLite | 通过。休眠再恢复后补齐 510 条事件，重启后的运行已中断，旧审批已收起。 |
| Go 与桌面 | `go test -race`、`go vet` 和桌面 Playwright 14 条用例通过。电源变化和系统睡眠通知通过测试注入验证。 |
| Vitest | 1,609 条通过，18 条跳过。包括经过本机 Go WSS 保持空闲 55 秒后仍能读取已认证状态的用例。 |
| Dart 与 Flutter | 2 条传输测试、5 条客户端测试、24 条 Flutter 组件测试通过。 |
| iPhone 17 Pro 模拟器、Android 16 模拟器 | `0.1.0-beta.5` Debug 构建 9 均已安装并启动，系统版本号 `0.1.0`。 |

实际 Wi-Fi 与蜂窝切换、笔记本电源切换和合盖行为留到最终设备验收，复验步骤见上文。
