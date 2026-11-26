import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

import '../mobile_glass.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';

bool connectionSupportsProjectManage(MobileConnection? connection) {
  if (connection == null) return false;
  try {
    return connection.supportsProjectManage;
  } on NoSuchMethodError {
    return false;
  }
}

bool connectionSupportsAgentManage(MobileConnection? connection) {
  if (connection == null) return false;
  try {
    return connection.supportsAgentManage;
  } on NoSuchMethodError {
    return false;
  }
}

bool connectionSupportsScheduleManage(MobileConnection? connection) {
  if (connection == null) return false;
  try {
    return connection.supportsScheduleManage;
  } on NoSuchMethodError {
    return false;
  }
}

bool connectionSupportsPluginManage(MobileConnection? connection) {
  if (connection == null) return false;
  try {
    return connection.supportsPluginManage;
  } on NoSuchMethodError {
    return false;
  }
}

String manageErrorMessage(Object error) {
  if (error is MobileRpcFailure) {
    return switch (error.problem.code) {
      'PROJECT_PATH_FORBIDDEN' => '该目录受系统保护或超出允许范围，无法访问。',
      'PROJECT_NOT_DIRECTORY' => '目标路径不存在或不是文件夹。',
      'AGENT_NOT_FOUND' => '电脑上未找到这个 Agent。',
      'AGENT_INSTANCE_NOT_FOUND' => '电脑上未找到这个 Agent 实例。',
      'AGENT_INSTANCE_ID_TAKEN' => '这个实例 ID 已被使用，请换一个名称。',
      'AGENT_INSTANCE_IN_USE' => '这个 Agent 实例正被现有会话使用，无法删除。',
      'AGENT_DEFAULT_INSTANCE_IMMUTABLE' => '默认实例不可删除、停用或修改名称。',
      'AGENT_SETTINGS_INVALID' => '设置格式不正确，请检查填写内容。',
      'SCHEDULE_NOT_FOUND' => '电脑上未找到这个定时任务。',
      'SCHEDULE_LEGACY_LOCKED' => '旧版会话绑定的定时任务不能修改运行配置。',
      'PLUGIN_NOT_FOUND' => '电脑上未找到这个插件。',
      'PLUGIN_BUILTIN_IMMUTABLE' => '内置插件不能卸载，只能停用。',
      'PLUGIN_CONFLICT' => '插件提供的服务与已启用的插件冲突。',
      'PLUGIN_ACTION_FAILED' =>
        error.problem.message.isNotEmpty
            ? error.problem.message
            : '插件操作失败，请检查网络或电脑端日志。',
      'RESOURCE_NOT_AVAILABLE' => '电脑上的这个项目或记录已不可用。',
      'DEVICE_REVOKED' => '这部手机的配对已失效，请重新扫码。',
      'METHOD_NOT_AVAILABLE' => '当前电脑版本暂不支持这项管理功能，请升级电脑端 Pigcode。',
      _ =>
        error.problem.message.isNotEmpty
            ? error.problem.message
            : '电脑暂时无法处理此请求，请重试。',
    };
  }
  if (error is ConnectionFailure) {
    return '电脑连接已断开，请重连后再试。';
  }
  return '操作失败，请稍后重试。';
}

class ManageOfflineBanner extends StatelessWidget {
  const ManageOfflineBanner({super.key});

  static const bannerKey = ValueKey('manage-offline-banner');

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Container(
      key: bannerKey,
      width: double.infinity,
      padding: const EdgeInsets.symmetric(
        horizontal: TimelineSpace.x6,
        vertical: TimelineSpace.x2,
      ),
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border(bottom: BorderSide(color: colors.divider)),
      ),
      child: Text('电脑连接已断开，正在重连…', style: TimelineType.metaStyle(colors.muted)),
    );
  }
}

Future<String?> showRenameProjectDialog(
  BuildContext context, {
  required String currentName,
}) => showDialog<String>(
  context: context,
  builder: (_) => _ProjectTextPromptDialog(
    title: '重命名项目',
    initialText: currentName,
    inputKey: const ValueKey('project-rename-input'),
    confirmKey: const ValueKey('project-rename-confirm'),
    labelText: '项目名称',
    hintText: '输入新的展示名',
    confirmLabel: '保存',
    allowEmpty: false,
  ),
);

Future<String?> showAddProjectNameDialog(
  BuildContext context, {
  required String displayPath,
  required String defaultName,
}) => showDialog<String>(
  context: context,
  builder: (_) => _ProjectTextPromptDialog(
    title: '添加项目',
    subtitleMono: displayPath,
    initialText: defaultName,
    inputKey: const ValueKey('project-add-name-input'),
    confirmKey: const ValueKey('project-add-confirm'),
    labelText: '项目展示名（可选）',
    hintText: '留空默认使用文件夹名',
    confirmLabel: '添加',
    allowEmpty: true,
  ),
);

class _ProjectTextPromptDialog extends StatefulWidget {
  const _ProjectTextPromptDialog({
    required this.title,
    required this.initialText,
    required this.inputKey,
    required this.confirmKey,
    required this.labelText,
    required this.hintText,
    required this.confirmLabel,
    required this.allowEmpty,
    this.subtitleMono,
  });

  final String title;
  final String? subtitleMono;
  final String initialText;
  final Key inputKey;
  final Key confirmKey;
  final String labelText;
  final String hintText;
  final String confirmLabel;
  final bool allowEmpty;

  @override
  State<_ProjectTextPromptDialog> createState() =>
      _ProjectTextPromptDialogState();
}

class _ProjectTextPromptDialogState extends State<_ProjectTextPromptDialog> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.initialText,
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final trimmed = _controller.text.trim();
    if (!widget.allowEmpty && trimmed.isEmpty) return;
    Navigator.of(context).pop(trimmed);
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final field = TextField(
      key: widget.inputKey,
      controller: _controller,
      autofocus: true,
      maxLength: 120,
      decoration: InputDecoration(
        labelText: widget.labelText,
        hintText: widget.hintText,
        counterText: '',
      ),
      onSubmitted: (_) => _submit(),
    );
    return MobileGlassDialog(
      title: Text(widget.title),
      content: widget.subtitleMono == null
          ? field
          : Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              spacing: TimelineSpace.x4,
              children: [
                Text(
                  widget.subtitleMono!,
                  style: TimelineType.metaMonoStyle(colors.secondaryText),
                ),
                field,
              ],
            ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          key: widget.confirmKey,
          onPressed: _submit,
          child: Text(widget.confirmLabel),
        ),
      ],
    );
  }
}

Future<bool> confirmRemoveProjectDialog(
  BuildContext context, {
  required String projectName,
}) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (dialogContext) {
      final colors = Theme.of(dialogContext).brightness == Brightness.dark
          ? pigcodeDark
          : pigcodeLight;
      return MobileGlassDialog(
        title: Text('移除「$projectName」？'),
        content: const Text('仅从项目列表移除，不会删除电脑上的文件夹和历史会话；该项目下正在运行的任务与终端会被停止。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            key: const ValueKey('project-remove-confirm'),
            style: FilledButton.styleFrom(
              backgroundColor: colors.error,
              foregroundColor: colors.onError,
            ),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('确认移除'),
          ),
        ],
      );
    },
  );
  return result == true;
}
