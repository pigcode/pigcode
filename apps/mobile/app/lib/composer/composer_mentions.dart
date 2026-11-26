import 'dart:math' as math;

import 'package:flutter/services.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../workspace_icon.dart';
import 'composer_catalog.dart';

/// `@` 联想列表最多展示的历史会话条数（对齐桌面 `composer-threads.ts`）。
const composerThreadSuggestionLimit = 5;

/// 读取 `connection.supportsComposerMentions`；在未覆写该属性的旧版桩连接上安全降级为 `false`。
bool connectionSupportsComposerMentions(MobileConnection? connection) {
  if (connection == null) return false;
  try {
    return connection.supportsComposerMentions;
  } on NoSuchMethodError {
    return false;
  }
}

/// 输入框触发符号类型。
enum ComposerTriggerKind {
  mention('@'),
  command('/'),
  skill(r'$');

  const ComposerTriggerKind(this.character);
  final String character;
}

/// 当前光标处命中的触发片段（区间 `[start, end)` 包含触发字符本身）。
final class ComposerTriggerMatch {
  const ComposerTriggerMatch({
    required this.kind,
    required this.start,
    required this.end,
    required this.query,
  });

  final ComposerTriggerKind kind;
  final int start;
  final int end;
  final String query;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ComposerTriggerMatch &&
          other.kind == kind &&
          other.start == start &&
          other.end == end &&
          other.query == query;

  @override
  int get hashCode => Object.hash(kind, start, end, query);

  @override
  String toString() =>
      'ComposerTriggerMatch($kind, $start..$end, query: "$query")';
}

bool _isWhitespaceCodeUnit(int codeUnit) =>
    codeUnit == 0x20 ||
    codeUnit == 0x09 ||
    codeUnit == 0x0A ||
    codeUnit == 0x0D ||
    codeUnit == 0x0B ||
    codeUnit == 0x0C ||
    codeUnit == 0x00A0 ||
    codeUnit == 0x3000;

/// 纯函数：识别光标前的 `@`、`/`、`$` 触发词。
/// - 选区未折叠或无效时返回 `null`；
/// - `/` 仅在文本开头或换行后行首触发，且 `/` 到光标之间无空白；
/// - `@` 与 `$` 在文本开头或空白字符后触发，且触发符到光标之间无空白。
ComposerTriggerMatch? detectComposerTrigger(TextEditingValue value) {
  final selection = value.selection;
  if (!selection.isValid || !selection.isCollapsed) return null;
  final cursor = selection.baseOffset;
  final text = value.text;
  if (cursor <= 0 || cursor > text.length) return null;

  var tokenStart = cursor;
  while (tokenStart > 0 &&
      !_isWhitespaceCodeUnit(text.codeUnitAt(tokenStart - 1))) {
    tokenStart--;
  }
  if (tokenStart >= cursor) return null;

  final lead = text.codeUnitAt(tokenStart);
  final ComposerTriggerKind? kind = switch (lead) {
    0x40 => ComposerTriggerKind.mention, // @
    0x24 => ComposerTriggerKind.skill, // $
    0x2F => // /
      (tokenStart == 0 ||
              text.codeUnitAt(tokenStart - 1) == 0x0A ||
              text.codeUnitAt(tokenStart - 1) == 0x0D)
          ? ComposerTriggerKind.command
          : null,
    _ => null,
  };
  if (kind == null) return null;

  return ComposerTriggerMatch(
    kind: kind,
    start: tokenStart,
    end: cursor,
    query: text.substring(tokenStart + 1, cursor),
  );
}

/// 纯函数：将触发区间 `[match.start, match.end)` 替换为 `replacement`，
/// 折叠光标到插入末尾并重置 `composing: TextRange.empty`。
TextEditingValue applyComposerTriggerInsertion(
  TextEditingValue value,
  ComposerTriggerMatch match,
  String replacement,
) {
  final text = value.text;
  final start = match.start.clamp(0, text.length);
  final end = match.end.clamp(start, text.length);
  final nextText = text.replaceRange(start, end, replacement);
  final nextOffset = start + replacement.length;
  return TextEditingValue(
    text: nextText,
    selection: TextSelection.collapsed(offset: nextOffset),
    composing: TextRange.empty,
  );
}

/// 纯函数：点击 `+` 插入菜单项时在光标处插入对应触发字符。
/// - `@`/`$`：若光标前非空且非空白，自动补一个空格以可靠激活联想；
/// - `/`：若光标位于空文本或行首直接插入 `/`，否则自动换行后插入 `/` 立即激活命令联想。
TextEditingValue insertComposerTriggerCharacter(
  TextEditingValue value,
  ComposerTriggerKind kind,
) {
  final text = value.text;
  final selection = value.selection;
  final start = selection.isValid
      ? selection.start.clamp(0, text.length)
      : text.length;
  final end = selection.isValid
      ? selection.end.clamp(start, text.length)
      : text.length;

  final String prefix;
  if (kind == ComposerTriggerKind.command) {
    final atLineStart =
        start == 0 ||
        text.codeUnitAt(start - 1) == 0x0A ||
        text.codeUnitAt(start - 1) == 0x0D;
    prefix = atLineStart ? '' : '\n';
  } else {
    final needsSpace =
        start > 0 && !_isWhitespaceCodeUnit(text.codeUnitAt(start - 1));
    prefix = needsSpace ? ' ' : '';
  }

  final insertion = '$prefix${kind.character}';
  final nextText = text.replaceRange(start, end, insertion);
  final nextOffset = start + insertion.length;
  return TextEditingValue(
    text: nextText,
    selection: TextSelection.collapsed(offset: nextOffset),
    composing: TextRange.empty,
  );
}

/// 把路径拆成文件名与淡显目录路径（对齐桌面 `suggestion-panel.tsx` 的 `splitPath`）。
({String name, String dir}) splitComposerPath(String path) {
  final normalized = path.replaceAll('\\', '/');
  final trailingSlash = normalized.endsWith('/') && normalized.length > 1;
  final trimmed = trailingSlash
      ? normalized.substring(0, normalized.length - 1)
      : normalized;
  final slash = trimmed.lastIndexOf('/');
  if (slash < 0) {
    return (name: trailingSlash ? '$trimmed/' : trimmed, dir: '');
  }
  final name = trimmed.substring(slash + 1);
  return (
    name: trailingSlash ? '$name/' : name,
    dir: trimmed.substring(0, slash),
  );
}

/// `@` 联想列表中的历史会话候选。
final class ComposerThreadSuggestion {
  const ComposerThreadSuggestion({
    required this.id,
    required this.title,
    required this.sameProject,
    required this.archived,
    this.projectName,
  });

  final String id;
  final String title;
  final bool sameProject;
  final bool archived;
  final String? projectName;

  MobileThreadReference toReference() =>
      MobileThreadReference(threadId: id, title: title);
}

/// 筛选可 `@` 引用的历史会话（严格对齐桌面 `composer-threads.ts`）：
/// - 自动排除当前正在打开的 `currentThreadId`；
/// - 查询词为空时优先列出当前项目未归档会话（最多 5 条）；
/// - 输入查询词后按标题不区分大小写子串跨全部项目（含其他项目与已归档会话）匹配（最多 5 条）。
List<ComposerThreadSuggestion> matchComposerThreads({
  required List<MobileThreadSummary> threads,
  required List<MobileProjectSummary> projects,
  String? currentProjectId,
  String? currentThreadId,
  required String query,
}) {
  if (threads.isEmpty) return const [];
  final projectNames = <String, String>{
    for (final project in projects) project.id: project.name,
  };
  final needle = query.trim().toLowerCase();
  final results = <ComposerThreadSuggestion>[];
  for (final thread in threads) {
    if (currentThreadId != null && thread.id == currentThreadId) continue;
    final sameProject =
        currentProjectId != null && thread.projectId == currentProjectId;
    if (needle.isEmpty) {
      if (!sameProject || thread.archived) continue;
    } else if (!thread.title.toLowerCase().contains(needle)) {
      continue;
    }
    results.add(
      ComposerThreadSuggestion(
        id: thread.id,
        title: thread.title,
        sameProject: sameProject,
        archived: thread.archived,
        projectName: projectNames[thread.projectId],
      ),
    );
    if (results.length >= composerThreadSuggestionLimit) break;
  }
  return List<ComposerThreadSuggestion>.unmodifiable(results);
}

/// 手机端内置 `/` 命令动作类型。
enum ComposerBuiltinActionKind {
  openModelPicker,
  togglePlanMode,
  setPermissionMode,
}

/// 手机端内置 `/` 命令定义（执行后直接删除输入中的 `/...` 触发文本）。
final class ComposerBuiltinCommand {
  const ComposerBuiltinCommand({
    required this.id,
    required this.label,
    required this.description,
    required this.actionKind,
    this.keywords = const [],
    this.permissionMode,
  });

  final String id;
  final String label;
  final String description;
  final ComposerBuiltinActionKind actionKind;
  final List<String> keywords;
  final MobileDraftPermission? permissionMode;
}

List<String> _permissionKeywords(MobileDraftPermission mode) => switch (mode) {
  MobileDraftPermission.approvalRequired => const ['监督审批', '权限', '审批'],
  MobileDraftPermission.autoAcceptEdits => const ['接受编辑', '权限', '编辑'],
  MobileDraftPermission.auto => const ['自动审批', '权限', '自动'],
  MobileDraftPermission.fullAccess => const ['完全访问', '权限'],
};

/// 构造当前上下文可用的内置 `/` 命令清单（对齐桌面 `composer-commands.ts`）：
/// - `/plan`：仅在 `supportsPlanMode == true` 时列出；
/// - `/model`：当允许打开模型弹层时列出；
/// - 非高危权限模式命令（排除需要二次确认的 `fullAccess`）。
List<ComposerBuiltinCommand> buildComposerBuiltinCommands({
  required bool canOpenModelPicker,
  required bool supportsPlanMode,
  required List<MobileDraftPermission> permissionModes,
}) {
  return List<ComposerBuiltinCommand>.unmodifiable([
    if (supportsPlanMode)
      const ComposerBuiltinCommand(
        id: 'plan',
        label: '/plan',
        description: '切换计划模式',
        keywords: ['计划', '计划模式', 'plan'],
        actionKind: ComposerBuiltinActionKind.togglePlanMode,
      ),
    if (canOpenModelPicker)
      const ComposerBuiltinCommand(
        id: 'model',
        label: '/model',
        description: '切换 Agent 和模型',
        keywords: ['模型', 'agent', 'model'],
        actionKind: ComposerBuiltinActionKind.openModelPicker,
      ),
    for (final mode in permissionModes)
      if (!composerPermissionNeedsConfirmation(mode))
        ComposerBuiltinCommand(
          id: 'permission-${mode.wire}',
          label: '/${mode.wire}',
          description: composerPermissionLabel(mode),
          keywords: _permissionKeywords(mode),
          actionKind: ComposerBuiltinActionKind.setPermissionMode,
          permissionMode: mode,
        ),
  ]);
}

/// 联想面板条目类型。
enum ComposerSuggestionKind { thread, file, command, skill }

/// 联想面板统一渲染条目。
final class ComposerSuggestionItem {
  const ComposerSuggestionItem({
    required this.kind,
    required this.id,
    required this.label,
    required this.glyph,
    this.detail,
    this.hint,
    this.tag,
    this.threadReference,
    this.filePath,
    this.builtinCommand,
    this.agentCommand,
  });

  final ComposerSuggestionKind kind;
  final String id;
  final String label;
  final WorkspaceGlyph glyph;
  final String? detail;
  final String? hint;
  final String? tag;
  final MobileThreadReference? threadReference;
  final String? filePath;
  final ComposerBuiltinCommand? builtinCommand;
  final MobileAgentCommand? agentCommand;
}

final _wordBoundarySplit = RegExp(r'[\s:._/\-]+');
final _leadingTriggerPrefix = RegExp(r'^[$/]+');

/// 对齐桌面 `skill-search.ts` 的排序打分函数：越小优先级越高，不命中返回 `double.infinity`。
double _rankField(
  String? value,
  String query,
  double base, {
  bool fuzzy = false,
}) {
  if (value == null || value.isEmpty) return double.infinity;
  final text = value.toLowerCase();
  if (text == query) return base;
  if (text.startsWith(query)) return base + 2;
  if (text.split(_wordBoundarySplit).any((word) => word.startsWith(query))) {
    return base + 4;
  }
  if (text.contains(query)) return base + 6;
  if (!fuzzy) return double.infinity;
  final score = composerFuzzyScore(text, query);
  return score >= 0 ? 100 + base + 1 / (1 + score) : double.infinity;
}

String? _commandSourceTag(MobileAgentCommand command) {
  if (command.isSkill) {
    return switch (command.source) {
      MobileAgentCommandSource.project => '项目',
      MobileAgentCommandSource.user => '用户',
      MobileAgentCommandSource.plugin => '插件',
      MobileAgentCommandSource.system => '系统',
      MobileAgentCommandSource.builtin => '内置',
      MobileAgentCommandSource.custom || null => 'Skill',
    };
  }
  return switch (command.source) {
    MobileAgentCommandSource.builtin => '内置',
    MobileAgentCommandSource.project => '项目',
    MobileAgentCommandSource.user => '用户',
    MobileAgentCommandSource.plugin => '插件',
    MobileAgentCommandSource.system => '系统',
    MobileAgentCommandSource.custom || null => null,
  };
}

List<String> _sourceSearchTerms(MobileAgentCommandSource? source) =>
    switch (source) {
      MobileAgentCommandSource.project => const ['project', '项目'],
      MobileAgentCommandSource.user => const ['user', '用户'],
      MobileAgentCommandSource.plugin => const ['plugin', '插件'],
      MobileAgentCommandSource.system => const ['system', '系统'],
      MobileAgentCommandSource.builtin => const ['builtin', '内置'],
      MobileAgentCommandSource.custom => const ['custom', '自定义'],
      null => const [],
    };

/// 构造 `@` 联想条目（会话在前，文件在后，对齐桌面 `composer-editor.ts`）。
List<ComposerSuggestionItem> buildMentionSuggestions({
  required List<ComposerThreadSuggestion> threads,
  required List<MobilePathEntry> paths,
}) {
  return List<ComposerSuggestionItem>.unmodifiable([
    for (final thread in threads)
      ComposerSuggestionItem(
        kind: ComposerSuggestionKind.thread,
        id: 'thread:${thread.id}',
        label: thread.title,
        detail: thread.sameProject ? null : thread.projectName,
        tag: thread.archived ? '已归档' : null,
        glyph: WorkspaceGlyph.messagesSquare,
        threadReference: thread.toReference(),
      ),
    for (final entry in paths)
      () {
        final parts = splitComposerPath(entry.path);
        return ComposerSuggestionItem(
          kind: ComposerSuggestionKind.file,
          id: 'file:${entry.path}',
          label: parts.name,
          detail: parts.dir.isEmpty ? null : parts.dir,
          glyph: entry.kind == MobilePathEntryKind.dir
              ? WorkspaceGlyph.folder
              : WorkspaceGlyph.fileText,
          filePath: entry.path,
        );
      }(),
  ]);
}

/// 合并并检索 `/` 内置命令与远程 Agent 命令（内置命令同名优先，对齐桌面 `composer-editor.ts` + `skill-search.ts`）。
List<ComposerSuggestionItem> buildSlashCommandSuggestions({
  required List<ComposerBuiltinCommand> builtins,
  required List<MobileAgentCommand> agentCommands,
  required String query,
}) {
  final slashCommands = agentCommands.where((cmd) => cmd.isSlashCommand);
  // 无查询时非 builtin 远程命令排在 Agent builtin 命令前，对齐桌面 `ordered()`。
  final orderedRemote = <MobileAgentCommand>[
    ...slashCommands.where(
      (cmd) => cmd.source != MobileAgentCommandSource.builtin,
    ),
    ...slashCommands.where(
      (cmd) => cmd.source == MobileAgentCommandSource.builtin,
    ),
  ];

  final seenLabels = <String>{};
  final candidates =
      <
        ({
          ComposerSuggestionItem item,
          String primaryName,
          String? displayName,
          String? shortDescription,
          String? description,
          List<String> keywords,
          List<String> scopes,
        })
      >[];

  for (final builtin in builtins) {
    final key = builtin.label.toLowerCase();
    if (!seenLabels.add(key)) continue;
    candidates.add((
      item: ComposerSuggestionItem(
        kind: ComposerSuggestionKind.command,
        id: 'builtin:${builtin.id}',
        label: builtin.label,
        detail: builtin.description,
        tag: '内置',
        glyph: WorkspaceGlyph.slash,
        builtinCommand: builtin,
      ),
      primaryName: builtin.label.replaceFirst(_leadingTriggerPrefix, ''),
      displayName: null,
      shortDescription: null,
      description: builtin.description,
      keywords: builtin.keywords,
      scopes: const ['builtin', '内置'],
    ));
  }

  for (final command in orderedRemote) {
    final key = command.text.toLowerCase();
    if (!seenLabels.add(key)) continue;
    candidates.add((
      item: ComposerSuggestionItem(
        kind: ComposerSuggestionKind.command,
        id: 'agent:${command.text}',
        label: command.text,
        detail: command.shortDescription ?? command.description,
        hint: command.argumentHint,
        tag: _commandSourceTag(command),
        glyph: command.source == MobileAgentCommandSource.builtin
            ? WorkspaceGlyph.terminal
            : WorkspaceGlyph.slash,
        agentCommand: command,
      ),
      primaryName: command.name,
      displayName: command.displayName,
      shortDescription: command.shortDescription,
      description: command.description,
      keywords: const [],
      scopes: _sourceSearchTerms(command.source),
    ));
  }

  final normalizedQuery = query
      .trim()
      .replaceFirst(_leadingTriggerPrefix, '')
      .toLowerCase();
  if (normalizedQuery.isEmpty) {
    return List<ComposerSuggestionItem>.unmodifiable(
      candidates.map((entry) => entry.item),
    );
  }

  final scored = <({ComposerSuggestionItem item, double score, int order})>[];
  for (var index = 0; index < candidates.length; index++) {
    final entry = candidates[index];
    var best = _rankField(entry.primaryName, normalizedQuery, 0, fuzzy: true);
    best = math.min(
      best,
      _rankField(entry.displayName, normalizedQuery, 1, fuzzy: true),
    );
    for (final keyword in entry.keywords) {
      best = math.min(
        best,
        _rankField(keyword, normalizedQuery, 10, fuzzy: true),
      );
    }
    best = math.min(
      best,
      _rankField(entry.shortDescription, normalizedQuery, 20),
    );
    best = math.min(best, _rankField(entry.description, normalizedQuery, 30));
    for (final scope in entry.scopes) {
      best = math.min(best, _rankField(scope, normalizedQuery, 40));
    }
    if (best.isFinite) {
      scored.add((item: entry.item, score: best, order: index));
    }
  }
  scored.sort((a, b) {
    final diff = a.score.compareTo(b.score);
    return diff != 0 ? diff : a.order.compareTo(b.order);
  });
  return List<ComposerSuggestionItem>.unmodifiable(
    scored.map((entry) => entry.item),
  );
}

/// 检索并排序 `$` Skill（对齐桌面 `skill-search.ts`）：
/// 按 `name`、`displayName`、`shortDescription`、`description`、`source` 打分排序。
List<ComposerSuggestionItem> buildSkillSuggestions({
  required List<MobileAgentCommand> agentCommands,
  required String query,
}) {
  final skills = agentCommands.where((cmd) => cmd.isSkill).toList();
  if (skills.isEmpty) return const [];

  ComposerSuggestionItem toItem(MobileAgentCommand command) =>
      ComposerSuggestionItem(
        kind: ComposerSuggestionKind.skill,
        id: 'skill:${command.text}',
        label: command.displayName ?? command.name,
        detail: command.shortDescription ?? command.description,
        hint: command.argumentHint,
        tag: _commandSourceTag(command),
        glyph: WorkspaceGlyph.sparkles,
        agentCommand: command,
      );

  final normalizedQuery = query
      .trim()
      .replaceFirst(_leadingTriggerPrefix, '')
      .toLowerCase();
  if (normalizedQuery.isEmpty) {
    return List<ComposerSuggestionItem>.unmodifiable(skills.map(toItem));
  }

  final scored = <({ComposerSuggestionItem item, double score, int order})>[];
  for (var index = 0; index < skills.length; index++) {
    final skill = skills[index];
    var best = _rankField(skill.name, normalizedQuery, 0, fuzzy: true);
    best = math.min(
      best,
      _rankField(skill.displayName, normalizedQuery, 1, fuzzy: true),
    );
    best = math.min(
      best,
      _rankField(skill.shortDescription, normalizedQuery, 20),
    );
    best = math.min(best, _rankField(skill.description, normalizedQuery, 30));
    for (final scope in _sourceSearchTerms(skill.source)) {
      best = math.min(best, _rankField(scope, normalizedQuery, 40));
    }
    if (best.isFinite) {
      scored.add((item: toItem(skill), score: best, order: index));
    }
  }
  scored.sort((a, b) {
    final diff = a.score.compareTo(b.score);
    return diff != 0 ? diff : a.order.compareTo(b.order);
  });
  return List<ComposerSuggestionItem>.unmodifiable(
    scored.map((entry) => entry.item),
  );
}
