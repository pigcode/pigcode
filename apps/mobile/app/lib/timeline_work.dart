import 'dart:convert';

import 'package:pigcode_client/pigcode_client.dart';

enum TimelineToolKind { read, search, fetch, edit, command, browser, other }

TimelineToolKind timelineToolKind(TimelineWork item) =>
    timelineToolKindForName(item.event.name ?? item.output?.name);

// 工具分类沿用桌面端 tool-identity.ts 的展示族。
TimelineToolKind timelineToolKindForName(String? toolName) {
  final name = (toolName ?? '').trim().toLowerCase();
  final parts = name.split('__');
  final action =
      parts.length >= 3 && parts.first == 'mcp' && parts[1].isNotEmpty
      ? parts.skip(2).join('__')
      : name;
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
    final joins =
        item.kind == TimelineWorkKind.reasoning ||
        (item.kind == TimelineWorkKind.tool &&
            timelineToolKind(item) != TimelineToolKind.other);
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

({String label, TimelineToolKind? icon}) summarizeTimelineWork(
  List<TimelineWork> items, {
  required bool finished,
}) {
  var explored = 0;
  var commands = 0;
  var editsWithoutPath = 0;
  var browser = false;
  final changedPaths = <String>{};
  for (final item in items.where(
    (item) => item.kind == TimelineWorkKind.tool,
  )) {
    final tool = timelineToolKind(item);
    switch (tool) {
      case TimelineToolKind.read ||
          TimelineToolKind.search ||
          TimelineToolKind.fetch:
        explored++;
      case TimelineToolKind.command || TimelineToolKind.browser:
        commands++;
        browser = browser || tool == TimelineToolKind.browser;
      case TimelineToolKind.edit:
        final paths = _editPaths(_toolInput(item)).map(_canonicalPath).toSet();
        if (paths.isEmpty) editsWithoutPath++;
        changedPaths.addAll(paths);
      case TimelineToolKind.other:
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
  return (
    label: labels.isEmpty ? '思考' : labels.join('，'),
    icon: browser
        ? TimelineToolKind.browser
        : changedPaths.isNotEmpty || editsWithoutPath != 0
        ? TimelineToolKind.edit
        : commands != 0
        ? TimelineToolKind.command
        : explored != 0
        ? TimelineToolKind.read
        : null,
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
    _ => null,
  };
}

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
