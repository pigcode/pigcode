import 'dart:convert';

import 'package:pigcode_client/pigcode_client.dart';

enum TimelineToolKind {
  read,
  search,
  fetch,
  edit,
  command,
  browser,
  mcp,
  skill,
  task,
  plan,
  ask,
  other,
}

TimelineToolKind timelineToolKind(TimelineWork item) =>
    timelineToolKindForName(item.event.name ?? item.output?.name);

/// 连续摘要组只收查阅、执行和修改；计划、提问和未知工具单独成行。
bool timelineJoinsSummary(TimelineWork item) {
  if (item.kind == TimelineWorkKind.reasoning) return true;
  if (item.kind != TimelineWorkKind.tool) return false;
  return switch (timelineToolKind(item)) {
    TimelineToolKind.read ||
    TimelineToolKind.search ||
    TimelineToolKind.fetch ||
    TimelineToolKind.edit ||
    TimelineToolKind.command ||
    TimelineToolKind.browser ||
    TimelineToolKind.mcp ||
    TimelineToolKind.skill ||
    TimelineToolKind.task => true,
    TimelineToolKind.plan ||
    TimelineToolKind.ask ||
    TimelineToolKind.other => false,
  };
}

// 工具分类沿用桌面端 tool-identity.ts 的展示族。
TimelineToolKind timelineToolKindForName(String? toolName) {
  final name = (toolName ?? '').trim().toLowerCase();
  final parts = name.split('__');
  final isMcp =
      parts.length >= 3 && parts.first == 'mcp' && parts[1].isNotEmpty;
  final action = isMcp ? parts.skip(2).join('__') : name;
  if (isMcp) return TimelineToolKind.mcp;
  if (action.startsWith('browser_') && action.length > 'browser_'.length) {
    return TimelineToolKind.browser;
  }
  return switch (name) {
    'read' || 'read_file' || 'view' || 'notebookread' => TimelineToolKind.read,
    'glob' ||
    'grep' ||
    'ls' ||
    'list' ||
    'find' ||
    'websearch' ||
    'web_search' ||
    'toolsearch' => TimelineToolKind.search,
    'webfetch' || 'web_fetch' || 'fetch' => TimelineToolKind.fetch,
    'write' ||
    'edit' ||
    'multiedit' ||
    'notebookedit' ||
    'applypatch' ||
    'apply_patch' ||
    'str_replace_based_edit_tool' => TimelineToolKind.edit,
    'bash' ||
    'shell' ||
    'exec' ||
    'exec_command' ||
    'local_shell' ||
    'run_command' ||
    'terminal' => TimelineToolKind.command,
    'skill' => TimelineToolKind.skill,
    'task' || 'taskoutput' || 'taskstop' => TimelineToolKind.task,
    'exitplanmode' || 'switch_mode' => TimelineToolKind.plan,
    'askuserquestion' => TimelineToolKind.ask,
    _ => TimelineToolKind.other,
  };
}

List<List<TimelineWork>> groupTimelineWork(
  List<TimelineWork> items,
  int pivot,
) {
  final result = <List<TimelineWork>>[];
  var group = <TimelineWork>[];
  for (final item in items) {
    final joins = timelineJoinsSummary(item);
    // 更早的分页从滚动锚点上方插入，已有行留在原来的列表里。
    final crossesAnchor =
        group.isNotEmpty &&
        ((group.first.event.seq < pivot) != (item.event.seq < pivot));
    if ((!joins || crossesAnchor) && group.isNotEmpty) {
      result.add(group);
      group = [];
    }
    if (joins) {
      group.add(item);
    } else {
      result.add([item]);
    }
  }
  if (group.isNotEmpty) result.add(group);
  return result;
}

({
  String label,
  String? singleFileLabel,
  TimelineToolKind? icon,
  List<String> files,
  bool filesOnly,
})
summarizeTimelineWork(List<TimelineWork> items, {required bool finished}) {
  var explored = 0;
  var commands = 0;
  var editsWithoutPath = 0;
  var browser = false;
  final seenPaths = <String>{};
  final changedPaths = <String>[];
  for (final item in items.where(
    (item) => item.kind == TimelineWorkKind.tool,
  )) {
    final tool = timelineToolKind(item);
    switch (tool) {
      case TimelineToolKind.read ||
          TimelineToolKind.search ||
          TimelineToolKind.fetch:
        explored++;
      case TimelineToolKind.command ||
          TimelineToolKind.browser ||
          TimelineToolKind.mcp ||
          TimelineToolKind.skill ||
          TimelineToolKind.task:
        commands++;
        browser = browser || tool == TimelineToolKind.browser;
      case TimelineToolKind.edit:
        final paths = _editPaths(_toolInput(item)).toList();
        if (paths.isEmpty) editsWithoutPath++;
        for (final path in paths) {
          final canonical = _canonicalPath(path);
          if (seenPaths.add(canonical)) changedPaths.add(path);
        }
      case TimelineToolKind.plan ||
          TimelineToolKind.ask ||
          TimelineToolKind.other:
        break;
    }
  }
  final tense = finished ? '已' : '';
  final labels = [
    if (explored != 0) '$tense查阅 $explored 项',
    if (commands != 0) '$tense执行 $commands 命令',
    if (changedPaths.isNotEmpty) '$tense修改 ${changedPaths.length} 文件',
    if (editsWithoutPath != 0) '$tense修改 $editsWithoutPath 次（路径未知）',
  ];
  final filesOnly =
      explored == 0 &&
      commands == 0 &&
      changedPaths.isNotEmpty &&
      editsWithoutPath == 0;
  return (
    label: labels.isEmpty ? '思考' : labels.join('，'),
    singleFileLabel: filesOnly && changedPaths.length == 1 ? '$tense修改' : null,
    icon: browser
        ? TimelineToolKind.browser
        : changedPaths.isNotEmpty || editsWithoutPath != 0
        ? TimelineToolKind.edit
        : commands != 0
        ? TimelineToolKind.command
        : explored != 0
        ? TimelineToolKind.read
        : null,
    files: changedPaths,
    filesOnly: filesOnly,
  );
}

String? timelineToolDetail(TimelineWork item, TimelineToolKind kind) {
  final input = _toolInput(item);
  final record = input is Map ? input : const {};
  final path = switch (kind) {
    TimelineToolKind.read =>
      _pathIn(record) ??
          (input is String && !input.startsWith('{') ? input : null),
    TimelineToolKind.edit => _editPaths(input).firstOrNull,
    _ => null,
  };
  if (path != null) return _canonicalPath(path).split('/').last;

  return switch (kind) {
    TimelineToolKind.command =>
      _field(record, ['description']) ??
          _command(record['command'] ?? record['cmd'] ?? input),
    TimelineToolKind.search => _field(record, ['pattern', 'query', 'path']),
    TimelineToolKind.fetch ||
    TimelineToolKind.browser => _field(record, ['description', 'url']),
    TimelineToolKind.mcp => _mcpDetail(item.event.name ?? item.output?.name),
    TimelineToolKind.skill => _field(record, ['name', 'skill', 'description']),
    TimelineToolKind.task => _field(record, [
      'description',
      'task_id',
      'taskId',
      'id',
    ]),
    _ => null,
  };
}

/// MCP 工具名 `mcp__server__tool` 拆成「服务 · 工具」。
({String server, String tool})? timelineMcpIdentity(String? name) {
  final parts = (name ?? '').trim().split('__');
  if (parts.length < 3 || parts.first != 'mcp' || parts[1].isEmpty) return null;
  return (server: parts[1], tool: parts.skip(2).join('__'));
}

String? _mcpDetail(String? name) {
  final identity = timelineMcpIdentity(name);
  if (identity == null) return null;
  return '${identity.server} · ${identity.tool}';
}

/// 读取工具输入里的 JSON 对象；截断的预览会尽量补全字段。
Map<Object?, Object?> timelineToolRecord(TimelineWork item) {
  final input = _toolInput(item);
  return input is Map ? input : const {};
}

/// 命令工具的完整命令文本。
String? timelineCommand(TimelineWork item) {
  final record = timelineToolRecord(item);
  final value = record['command'] ?? record['cmd'];
  if (value is String && value.trim().isNotEmpty) return value.trim();
  if (value is List) {
    final joined = value.whereType<String>().join(' ').trim();
    if (joined.isNotEmpty) return joined;
  }
  final input = _toolInput(item);
  return input is String && !input.startsWith('{') ? input : null;
}

/// 命令工具的一行说明，优先用 Agent 给的 description。
String? timelineCommandDescription(TimelineWork item) =>
    _field(timelineToolRecord(item), ['description']);

/// 去掉终端输出里的 ANSI 控制序列。
String timelineStripAnsi(String value) =>
    value.replaceAll(RegExp('\x1B\\[[0-?]*[ -/]*[@-~]'), '');

/// 编辑类工具的增删行数；无法判断时返回 null。
({int added, int removed})? timelineEditStats(TimelineWork item) {
  final input = _toolInput(item);
  var added = 0;
  var removed = 0;
  var found = false;
  void count(Object? oldValue, Object? newValue) {
    if (oldValue is String && oldValue.isNotEmpty) {
      removed += oldValue.split('\n').length;
      found = true;
    }
    if (newValue is String && newValue.isNotEmpty) {
      added += newValue.split('\n').length;
      found = true;
    }
  }

  if (input is Map) {
    final edits = input['edits'] ?? input['changes'];
    if (edits is List) {
      for (final entry in edits.whereType<Map>()) {
        count(
          _field(entry, ['old_string', 'oldString', 'old']),
          _field(entry, ['new_string', 'newString', 'new']),
        );
      }
    }
    count(
      _field(input, ['old_string', 'oldString']),
      _field(input, ['new_string', 'newString', 'content']),
    );
    final patch = input['patch'];
    if (patch is String && patch.contains('\n')) {
      var patchFound = false;
      for (final line in patch.split('\n')) {
        if (line.startsWith('***') || line.startsWith('@@')) continue;
        if (line.startsWith('+')) {
          added++;
          patchFound = true;
        } else if (line.startsWith('-')) {
          removed++;
          patchFound = true;
        }
      }
      found = found || patchFound;
    }
  }
  return found ? (added: added, removed: removed) : null;
}

/// 工具输出；没有完成事件时为空。
String? timelineToolOutput(TimelineWork item) => item.output?.text;

Object? _toolInput(TimelineWork item) {
  final input = item.input;
  final text = input?.text?.trim();
  if (text == null || text.isEmpty) return null;
  if (text.startsWith('{') || text.startsWith('[') || text.startsWith('"')) {
    try {
      return jsonDecode(text);
    } on FormatException {
      // 分页里可能只有输入预览，详情仍可按事件序号打开。
      if (input?.truncated == true) return _completeInputFields(text) ?? text;
    }
  }
  return text;
}

Object? _completeInputFields(String text) {
  final closing = text.startsWith('{')
      ? '}'
      : text.startsWith('[')
      ? ']'
      : null;
  if (closing == null) return null;
  var depth = 0;
  var quoted = false;
  var escaped = false;
  var lastComma = -1;
  for (var index = 0; index < text.length; index++) {
    final character = text[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character == '\\') {
        escaped = true;
      } else if (character == '"') {
        quoted = false;
      }
    } else if (character == '"') {
      quoted = true;
    } else if (character == '{' || character == '[') {
      depth++;
    } else if (character == '}' || character == ']') {
      depth--;
    } else if (character == ',' && depth == 1) {
      lastComma = index;
    }
  }
  if (lastComma < 0) return null;
  try {
    return jsonDecode(text.substring(0, lastComma) + closing);
  } on FormatException {
    return null;
  }
}

String? _command(Object? value) => switch (value) {
  String() => value.split('\n').first.trim(),
  List() => value.whereType<String>().join(' '),
  _ => null,
};

String? _field(Map<Object?, Object?> record, List<String> keys) {
  for (final key in keys) {
    final value = record[key];
    if (value is String && value.trim().isNotEmpty) return value.trim();
  }
  return null;
}

String? _pathIn(Map<Object?, Object?> record) => _field(record, [
  'file_path',
  'path',
  'filePath',
  'notebook_path',
  'filename',
]);

final _patchPath = RegExp(
  r'^\*\*\* (?:Add|Update|Delete) File: (.+)$',
  multiLine: true,
);

Iterable<String> _editPaths(Object? input) sync* {
  if (input is Map) {
    if (_pathIn(input) case final path?) yield path;
  }
  final changes = input is Map ? input['changes'] ?? input['patch'] : input;
  if (changes is List) {
    for (final entry in changes.whereType<Map>()) {
      if (_pathIn(entry) case final path?) yield path;
    }
  } else if (changes is String) {
    for (final match in _patchPath.allMatches(changes)) {
      yield match.group(1)!.trim();
    }
  }
}

String _canonicalPath(String value) {
  final path = value.replaceAll('\\', '/');
  final root =
      RegExp(r'^(?:[a-z]:/|/)', caseSensitive: false).stringMatch(path) ?? '';
  final parts = <String>[];
  for (final segment in path.substring(root.length).split('/')) {
    if (segment.isEmpty || segment == '.') continue;
    if (segment == '..' && parts.isNotEmpty && parts.last != '..') {
      parts.removeLast();
    } else if (segment != '..' || root.isEmpty) {
      parts.add(segment);
    }
  }
  return '$root${parts.join('/')}';
}
