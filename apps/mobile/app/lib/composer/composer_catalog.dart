import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../workspace_icon.dart';

/// 读取 `connection.supportsComposerControls`；在未覆写该标志的测试或视觉基线桩连接上温和降级为 `false`。
bool connectionSupportsComposerControls(MobileConnection? connection) {
  if (connection == null) return false;
  try {
    return connection.supportsComposerControls;
  } on NoSuchMethodError {
    return false;
  }
}

/// 共享的 Agent 实例目录 provider（供新会话草稿、已有会话输入框与模型弹层复用）。
final composerDraftOptionsProvider = FutureProvider.autoDispose
    .family<MobileDraftOptions, MobileConnection>(
      (ref, connection) => connection.drafts.options(),
    );

/// 共享的按实例懒加载模型目录 provider。
final composerDraftModelsProvider = FutureProvider.autoDispose
    .family<MobileDraftModels, (MobileConnection, String)>(
      (ref, target) => target.$1.drafts.models(target.$2),
    );

/// 思考深度中文展示名，完全对齐桌面端 `composer-options.ts` + `messages.zh-CN.ts`。
String composerEffortLabel(String effort) => switch (effort) {
  'none' => '不思考',
  'minimal' => '最低',
  'low' => '低',
  'medium' => '中',
  'high' => '高',
  'xhigh' => '很高',
  'max' => '最高',
  'ultra' => '极限',
  _ => _humanizeEffort(effort),
};

String _humanizeEffort(String effort) {
  final words = effort.replaceAll(RegExp(r'[_-]+'), ' ').trim();
  if (words.isEmpty) return effort;
  return '${words[0].toUpperCase()}${words.substring(1)}';
}

/// 权限模式展示名（严格对齐 `GLOSSARY.md` 术语）。
String composerPermissionLabel(MobileDraftPermission mode) => switch (mode) {
  MobileDraftPermission.approvalRequired => '监督审批',
  MobileDraftPermission.autoAcceptEdits => '接受编辑',
  MobileDraftPermission.auto => '自动审批',
  MobileDraftPermission.fullAccess => '完全访问',
};

/// 权限模式说明文案（对齐 `packages/contracts/src/locale/runtime-modes.ts`）。
String composerPermissionDescription(MobileDraftPermission mode) =>
    switch (mode) {
      MobileDraftPermission.approvalRequired => '要改文件或跑命令时，先问你',
      MobileDraftPermission.autoAcceptEdits => '直接改文件，别的事先问你',
      MobileDraftPermission.auto => 'Agent 自己判断要不要问你，做不到时先问你',
      MobileDraftPermission.fullAccess => '不问你，直接改文件、跑命令',
    };

/// 权限模式矢量图标（对齐桌面端 `permission-options.ts`）。
WorkspaceGlyph composerPermissionGlyph(MobileDraftPermission mode) =>
    switch (mode) {
      MobileDraftPermission.approvalRequired => WorkspaceGlyph.hand,
      MobileDraftPermission.autoAcceptEdits => WorkspaceGlyph.pencil,
      MobileDraftPermission.auto => WorkspaceGlyph.sparkles,
      MobileDraftPermission.fullAccess => WorkspaceGlyph.shieldAlert,
    };

/// 是否属于需要二次确认的提权模式。
bool composerPermissionNeedsConfirmation(MobileDraftPermission mode) =>
    mode == MobileDraftPermission.fullAccess;

/// 子序列模糊匹配打分（对齐桌面端 `fuzzy.ts`）；不匹配返回 -1。
double composerFuzzyScore(String text, String query) {
  if (query.isEmpty) return 0;
  final haystack = text.toLowerCase();
  final needle = query.toLowerCase();
  var score = 0.0;
  var from = 0;
  var previous = -2;
  for (var i = 0; i < needle.length; i++) {
    final index = haystack.indexOf(needle[i], from);
    if (index < 0) return -1;
    score += index == previous + 1 ? 3 : 1;
    if (index == 0 ||
        haystack[index - 1] == '/' ||
        haystack[index - 1] == '-' ||
        haystack[index - 1] == '_' ||
        haystack[index - 1] == '.') {
      score += 2;
    }
    previous = index;
    from = index + 1;
  }
  return score - haystack.length * 0.01;
}
