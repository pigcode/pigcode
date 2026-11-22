# 手机离线缓存和本机草稿

[离线查看缓存并恢复本机草稿 #124](https://github.com/pigcode/monorepo/issues/124)

## 离线查看

连接过电脑并打开会话后，手机保存最近一次项目与会话摘要及已经加载的持久时间线。回到「电脑」页选择已配对电脑即可读取当前缓存。离线显示上次同步时间，侧栏隐藏运行、待处理和未读标记。完整工具输出、差异和运行中的实时输出在联网时读取。连回电脑后以 Host 的完整摘要刷新列表，按历史游标补齐会话。 [弱网同步决策](https://github.com/pigcode/monorepo/issues/92#issuecomment-7072108758)

每台电脑的缓存独立加密保存，密钥放在本机系统安全存储。加密文件使用 AES-256-GCM，认证数据绑定电脑公钥。单台电脑的起始预算为 32 项、每项 256 KiB、总计 2 MiB。优先保留最新列表，先淘汰最久未打开的时间线。很长的时间线保留最近的已加载事件，联网后仍可按位置上翻。 [DSH Go 缓存预算](https://github.com/ccch1mneyyy/dsh-Go/blob/a57078e842850793f1733ebd23f730a01d714e86/app/lib/state/read_list_cache.dart#L46-L53)

## 草稿和撤销

手机保存最近修改的 30 份本机草稿，按电脑和会话区分。新会话草稿同时保存项目、Agent 实例、模型和权限。离线可以写入，恢复连接后验证选项再发送。待确认的命令和撤回结果单独保留，收到回执后再处理原来的编号。 [DSH Go 草稿保留](https://github.com/ccch1mneyyy/dsh-Go/blob/a57078e842850793f1733ebd23f730a01d714e86/app/lib/state/draft_store.dart#L20-L35) · [分端草稿决策](https://github.com/pigcode/monorepo/issues/93#issuecomment-7073510830)

移除电脑、成功新配对或收到该 Host 的认证撤销确认时，清理对应电脑的离线缓存、缓存密钥及本机草稿。更新同一配对的中继保留本机数据。撤销通知通过 Noise 连接或受固定电脑公钥认证的握手拒绝送达。撤销最后一台设备会关闭电脑的常驻中继。Host 不可达期间，已有缓存继续由手机本机密钥保护。清理中断后，下次启动会先继续处理该电脑的清理记录。 [配对与本机保护](https://github.com/pigcode/monorepo/issues/97#issuecomment-7069781487) · [更新中继和撤销设备](mobile-pairing.md#更新中继和撤销配对)

## 本机验收

~~~sh
(cd apps/mobile && dart analyze --fatal-infos)
(cd apps/mobile/app && flutter test --no-pub test/{offline_cache,offline_workspace,local_drafts,computer_storage,run_composer,message_queue,new_thread_draft,computer_reconnect}_test.dart)
pnpm exec vitest run apps/host/src/rpc/{mobile-device-management,mobile-pairing}.test.ts
~~~

Host 用例使用[两个本机 Go 中继](mobile-pairing.md#两个-go-中继的验收)的 CA、地址和令牌。验证连接中撤销、Host 重启后认证拒绝、另一部手机继续连接，以及最后一部设备撤销后中继离线。Flutter 用例验证加密文件跨实例恢复、读取失败时的容量保护、启动补清、离线恢复两类草稿和在回执恢复时保留未提交的新输入。

~~~sh
(cd apps/mobile && PIGCODE_MOBILE_BUILD_NUMBER=11 ./scripts/flutter-app.sh build ios --simulator --debug)
(cd apps/mobile && PIGCODE_MOBILE_BUILD_NUMBER=11 ./scripts/flutter-app.sh build apk --debug)
~~~

设备复验先配对两台电脑，各打开一条会话并加载较早历史，分别写既有会话和新会话草稿。关闭网络并重开 App，从电脑列表分别进入缓存，核对同步时间、历史和已选设置。恢复网络后核对已删除的会话退出最新列表。在任一 Host 上撤销已连接手机，检查本机移除该电脑，另一台电脑的本机数据可继续打开。

## 2026-11-23 验收记录

| 范围 | 结果 |
| --- | --- |
| Go WSS 回环 | 配对、连接中撤销、重启后认证拒绝、最后一部设备撤销后退出中继均通过。 |
| Vitest | 1,614 条通过，18 条跳过。会话详情卡的一条断言在此前基准也失败。 |
| Dart 和 Flutter | 7 条 Dart 测试、38 条 Flutter 组件测试通过，格式和静态分析通过。 |
| 桌面 Playwright | 中继设置、配对、设备撤销、重连及待处理提问共 5 条通过。 |
| iOS 与 Android | iPhone 17 Pro 和 Android 16 模拟器均已安装并启动 `0.1.0-beta.5` Debug 构建 11。 |
