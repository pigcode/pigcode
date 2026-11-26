import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../app_theme.dart';
import '../mobile_glass.dart';
import '../mobile_status_dot.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';
import 'manage_utils.dart';
import 'project_manage_screen.dart';

/// 手机端统一「设置」主页：聚合当前电脑的管理入口（项目、Agent 实例，为 5B 预留定时任务/插件）与手机本机设置。
class SettingsHubScreen extends StatelessWidget {
  const SettingsHubScreen({
    super.key,
    required this.connectionListenable,
    required this.computerName,
    this.onOpenReminders,
    this.onComputers,
    this.onOpenAgents,
  });

  static const projectsTileKey = ValueKey('settings-hub-projects');
  static const agentsTileKey = ValueKey('settings-hub-agents');
  static const remindersTileKey = ValueKey('settings-hub-reminders');
  static const computersTileKey = ValueKey('settings-hub-computers');

  final ValueListenable<MobileConnection?> connectionListenable;
  final String computerName;
  final VoidCallback? onOpenReminders;
  final VoidCallback? onComputers;
  final void Function(BuildContext context)? onOpenAgents;

  static Future<void> open(
    BuildContext context, {
    required ValueListenable<MobileConnection?> connectionListenable,
    required String computerName,
    VoidCallback? onOpenReminders,
    VoidCallback? onComputers,
    void Function(BuildContext context)? onOpenAgents,
  }) => Navigator.of(context).push<void>(
    MaterialPageRoute<void>(
      builder: (_) => SettingsHubScreen(
        connectionListenable: connectionListenable,
        computerName: computerName,
        onOpenReminders: onOpenReminders,
        onComputers: onComputers,
        onOpenAgents: onOpenAgents,
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
        final canProjects = online && connectionSupportsProjectManage(connection);
        final canAgents =
            online &&
            connectionSupportsAgentManage(connection) &&
            onOpenAgents != null;
        final activeName = connection?.computerName ?? computerName;

        return Scaffold(
          backgroundColor: colors.background,
          appBar: AppBar(
            title: const Text('设置'),
            centerTitle: true,
            scrolledUnderElevation: 0,
            systemOverlayStyle: pigcodeSystemOverlay(theme.brightness),
            leadingWidth: 58,
            leading: Align(
              alignment: AlignmentDirectional.centerStart,
              child: MobileGlassChromeButton(
                padding: const EdgeInsetsDirectional.only(start: 10),
                child: SizedBox.square(
                  dimension: 40,
                  child: IconButton(
                    tooltip: '返回',
                    padding: EdgeInsets.zero,
                    onPressed: () => Navigator.maybePop(context),
                    icon: const RotatedBox(
                      quarterTurns: 1,
                      child: WorkspaceIcon(
                        WorkspaceGlyph.chevronDown,
                        size: 20,
                      ),
                    ),
                  ),
                ),
              ),
            ),
            bottom: PreferredSize(
              preferredSize: const Size.fromHeight(1),
              child: Divider(height: 1, thickness: 1, color: colors.divider),
            ),
          ),
          body: SafeArea(
            top: false,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
              children: [
                _SectionHeader(
                  title: '当前电脑 · $activeName',
                  trailing: Row(
                    mainAxisSize: MainAxisSize.min,
                    spacing: 6,
                    children: [
                      MobileStatusDot(
                        color: online ? colors.readyMark : colors.faint,
                      ),
                      Text(
                        online ? '已连接' : '离线',
                        style: TimelineType.metaStyle(colors.muted),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 8),
                _SettingsCard(
                  children: [
                    ListTile(
                      key: projectsTileKey,
                      leading: IconTheme(
                        data: IconThemeData(color: colors.secondaryText),
                        child: const WorkspaceIcon(
                          WorkspaceGlyph.folder,
                          size: 20,
                        ),
                      ),
                      title: const Text('项目管理'),
                      subtitle: Text(
                        !online
                            ? '电脑离线，连接后可管理'
                            : canProjects
                            ? '浏览电脑目录添加、重命名或移除项目'
                            : '当前电脑版本不支持手机端项目管理',
                        style: TimelineType.metaStyle(colors.muted),
                      ),
                      trailing: Icon(
                        Icons.chevron_right,
                        size: 18,
                        color: colors.faint,
                      ),
                      enabled: canProjects,
                      onTap: canProjects
                          ? () => ProjectManageScreen.open(
                              context,
                              connectionListenable: connectionListenable,
                            )
                          : null,
                    ),
                    if (onOpenAgents != null) ...[
                      Divider(height: 1, indent: 56, color: colors.divider),
                      ListTile(
                        key: agentsTileKey,
                        leading: IconTheme(
                          data: IconThemeData(color: colors.secondaryText),
                          child: const WorkspaceIcon(
                            WorkspaceGlyph.bot,
                            size: 20,
                          ),
                        ),
                        title: const Text('Agent 实例'),
                        subtitle: Text(
                          !online
                              ? '电脑离线，连接后可管理'
                              : canAgents
                              ? '检测状态、默认选择、新建与编辑自定义实例'
                              : '当前电脑版本不支持手机端 Agent 管理',
                          style: TimelineType.metaStyle(colors.muted),
                        ),
                        trailing: Icon(
                          Icons.chevron_right,
                          size: 18,
                          color: colors.faint,
                        ),
                        enabled: canAgents,
                        onTap: canAgents ? () => onOpenAgents!(context) : null,
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 22),
                const _SectionHeader(title: '手机本机'),
                const SizedBox(height: 8),
                _SettingsCard(
                  children: [
                    if (onOpenReminders != null)
                      ListTile(
                        key: remindersTileKey,
                        leading: Icon(
                          Icons.notifications_outlined,
                          size: 20,
                          color: colors.secondaryText,
                        ),
                        title: const Text('通知设置'),
                        subtitle: Text(
                          '管理手机提醒开关与系统通知权限',
                          style: TimelineType.metaStyle(colors.muted),
                        ),
                        trailing: Icon(
                          Icons.chevron_right,
                          size: 18,
                          color: colors.faint,
                        ),
                        onTap: onOpenReminders,
                      ),
                    if (onOpenReminders != null && onComputers != null)
                      Divider(height: 1, indent: 56, color: colors.divider),
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
                        title: const Text('电脑与配对管理'),
                        subtitle: Text(
                          '切换电脑、扫码配对或移除已保存配置',
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
              ],
            ),
          ),
        );
      },
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.title, this.trailing});

  final String title;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Row(
        children: [
          Expanded(
            child: Text(
              title,
              style: TimelineType.metaStyle(
                colors.muted,
                weight: FontWeight.w500,
              ),
            ),
          ),
          ?trailing,
        ],
      ),
    );
  }
}

class _SettingsCard extends StatelessWidget {
  const _SettingsCard({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Material(
      color: colors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: colors.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(mainAxisSize: MainAxisSize.min, children: children),
    );
  }
}
