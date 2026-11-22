# 在手机按 run 查看改动

手机会话中有改动的一轮会显示文件清单和增删行数。点开进入只读全屏 diff，点文件胶囊或横划切换。正文默认换行。关闭换行后可横向滚动正文，也可在显示完整文件路径的横条上滑动切换文件。使用系统返回可以回到原会话。 [方案 D](../apps/mobile/DESIGN.md#输入待处理和改动) · [DSH Go 的文件胶囊和全屏差异](https://github.com/ccch1mneyyy/dsh-Go/blob/36f232df1deba9be9730f068b8db80f2a5cbbda7/app/lib/ui/chat/diff_page.dart#L18-L69)

## 数据与范围

- 起点在 Agent 开始执行前取自其实际工作目录，终点等原生执行和中断清理完成。同一工作树后续的基线等待这次终点。切换工作树后，Host 在选定目录续用对应会话，缺少该目录的会话时重新建立并交接上下文。Git 对象库存有快照时，原工作树移除后也能按原目录前缀回读。
- 手机协商 `changes.read` 后，用 `run.changes` 查询该轮文件，用 `run.diff` 按文件读取补丁。Host 核对配对身份、会话、该轮 run 和该轮确实改动的文件。单页补丁最多 8,192 个 UTF-16 单元，按继续读取按钮接续。
- 检查点不可用时保留已保存的文件清单。同一工作树的并发窗口无法按 run 归属时提示原因，并显示已有的该轮文件记录。旧检查点依照当时 Agent 会话和项目范围读取，保留无法确认工作树来源的旧文件记录。 [按 run 的 RPC 决策](https://github.com/pigcode/monorepo/issues/91#issuecomment-7070294711)

## 验收

从前端仓库根目录运行 Host 和契约检查。

~~~sh
pnpm exec vitest run apps/host/src/mobile/run-changes.test.ts \
  apps/host/src/services/{checkpoints,git}.test.ts apps/host/src/rpc/host-activity.test.ts
node apps/desktop/scripts/generate-mobile-contracts.ts --check
node apps/desktop/scripts/generate-mobile-theme.ts --check
~~~

配置[本机 Go WSS](mobile-pairing.md#本机-go-回环)的 CA、地址和令牌后重跑同一命令，启用配对后的 Dart 实际回环。验证了同一文件的两轮历史差异、停止时最后一次写入、旧工作树移除后的回读、并发工作树的归属提示、非该轮文件拒绝、快照丢失时保留文件清单，以及 2,400 行长补丁分段读取。

~~~sh
(cd apps/mobile/app && flutter test test/run_changes_test.dart)
(cd apps/mobile && PIGCODE_MOBILE_BUILD_NUMBER=10 ./scripts/flutter-app.sh build ios --simulator --debug)
(cd apps/mobile && PIGCODE_MOBILE_BUILD_NUMBER=10 ./scripts/flutter-app.sh build apk --debug)
~~~

配对后，在电脑同一个项目中连续做两轮对同一文件的修改，保留带新文件、删除和超长文本的样例。从手机分别打开两轮改动卡，比较各自的增删、行号和补丁。用胶囊和横划切换文件，关闭换行验证正文横滚与路径条切换，返回检查会话位置。另在两个会话中使用同一工作树并行修改，核对手机明确显示共享工作树无法按轮归属。

## 2026-11-23 验收记录

| 范围 | 结果 |
| --- | --- |
| 本机 Go WSS 与 Host 定向回归 | 61 条通过，覆盖快照归属、原生清理、历史工作树和移动端传输。 |
| Dart 和 Flutter | 7 条 Dart 测试、27 条 Flutter 组件测试通过，格式、静态分析和生成检查通过。 |
| 桌面 Playwright | 12 条通过。本机 `m3-workbench.spec.ts` 在上一提交 `722d7b9` 也复现了手动检查点后的同一断言失败。 |
| iOS 与 Android | iPhone 17 Pro 和 Android 16 模拟器均已安装并启动 `0.1.0-beta.5` Debug 构建 10。 |
