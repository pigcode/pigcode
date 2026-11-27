import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../app_theme.dart';
import '../mobile_glass.dart';
import '../mobile_status_dot.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';
import 'manage_form_widgets.dart';

/// 手机端本机设置主页（侧栏右下角 `⚙️` 入口）：
/// 聚焦手机自身功能，包括通知设置与已配对电脑汇总总览；
/// 当前电脑的定时任务、插件管理、Agent 实例与项目管理均已收归到侧栏主菜单。
class SettingsHubScreen extends StatelessWidget {
  const SettingsHubScreen({
    super.key,
    required this.connectionListenable,
    required this.computerName,
    this.onOpenReminders,
    this.onComputers,
  });

  static const remindersTileKey = ValueKey('settings-hub-reminders');
  static const computersTileKey = ValueKey('settings-hub-computers');

  final ValueListenable<MobileConnection?> connectionListenable;
  final String computerName;
  final VoidCallback? onOpenReminders;
  final VoidCallback? onComputers;

  static Future<void> open(
    BuildContext context, {
    required ValueListenable<MobileConnection?> connectionListenable,
    required String computerName,
    VoidCallback? onOpenReminders,
    VoidCallback? onComputers,
  }) => Navigator.of(context).push<void>(
    MaterialPageRoute<void>(
      builder: (_) => SettingsHubScreen(
        connectionListenable: connectionListenable,
        computerName: computerName,
        onOpenReminders: onOpenReminders,
        onComputers: onComputers,
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    return ValueListenableBuilder<MobileConnection?>(
      valueListenable: connectionListenable,
      builder: (context, connection, _) {
        final online = connection != null;
        final activeName = connection?.computerName ?? computerName;

        return Scaffold(
          backgroundColor: colors.background,
          appBar: AppBar(
            title: const Text('手机设置'),
            centerTitle: true,
            scrolledUnderElevation: 0,
            systemOverlayStyle: pigcodeSystemOverlay(theme.brightness),
            leadingWidth: 58,
            leading: Align(
              alignment: AlignmentDirectional.centerStart,
              child: MobileGlassChromeButton(
                padding: const EdgeInsetsDirectional.only(start: 10),
                child: const SizedBox.square(
                  dimension: 40,
                  child: BackButton(),
                ),
              ),
            ),
          ),
          body: ListView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
            children: [
              const ManageSectionHeader(title: '手机与通知'),
              const SizedBox(height: 8),
              ManageSurfaceCard(
                children: [
                  if (onOpenReminders != null) ...[
                    ListTile(
                      key: remindersTileKey,
                      leading: Icon(
                        Icons.notifications_outlined,
                        size: 20,
                        color: colors.secondaryText,
                      ),
                      title: const Text('通知设置'),
                      subtitle: Text(
                        '管理提醒开关、安静时段与推送权限',
                        style: TimelineType.metaStyle(colors.muted),
                      ),
                      trailing: Icon(
                        Icons.chevron_right,
                        size: 18,
                        color: colors.faint,
                      ),
                      onTap: onOpenReminders,
                    ),
                    if (onComputers != null)
                      Divider(height: 1, indent: 56, color: colors.divider),
                  ],
                  if (onComputers != null)
                    ListTile(
                      key: computersTileKey,
                      leading: IconTheme(
                        data: IconThemeData(color: colors.secondaryText),
                        child: const WorkspaceIcon(
                          WorkspaceGlyph.laptop,
                          size: 20,
                        ),
                      ),
                      title: const Text('全部电脑与配对管理'),
                      subtitle: Text(
                        '查看跨电脑待办总览、扫码配对或移除设备',
                        style: TimelineType.metaStyle(colors.muted),
                      ),
                      trailing: Icon(
                        Icons.chevron_right,
                        size: 18,
                        color: colors.faint,
                      ),
                      onTap: () {
                        Navigator.of(context).pop();
                        onComputers!();
                      },
                    ),
                ],
              ),
              const SizedBox(height: 22),
              const ManageSectionHeader(title: '当前连接状态'),
              const SizedBox(height: 8),
              ManageSurfaceCard(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 14,
                ),
                children: [
                  Row(
                    children: [
                      MobileStatusDot(
                        color: online ? colors.readyMark : colors.faint,
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          activeName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TimelineType.contentStyle(
                            colors.foreground,
                            weight: FontWeight.w500,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        online ? '已连接' : '离线重连中',
                        style: TimelineType.metaStyle(
                          online ? colors.readyMark : colors.muted,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(
                    '定时任务、插件、Agent 实例与项目均可在侧栏直接打开；点击底部电脑胶囊可原地切换电脑。',
                    style: TimelineType.smallStyle(colors.muted),
                  ),
                ],
              ),
            ],
          ),
        );
      },
    );
  }
}
