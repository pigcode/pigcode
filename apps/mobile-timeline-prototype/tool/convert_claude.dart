// 把 Claude Code 的会话记录（~/.claude/projects/**/*.jsonl）转成 Pigcode 的线程事件，写到 assets/session.json。
// 生成的文件含真实对话内容，已在 .gitignore 里，不要提交。
//
// 用法：dart run tool/convert_claude.dart <会话.jsonl> [输出路径]
import 'dart:convert';
import 'dart:io';

const _maxOutput = 100 * 1024;

String _resultText(Object? content) {
  if (content is String) return content;
  if (content is List) {
    return content
        .map((block) {
          if (block is! Map) return '';
          if (block['type'] == 'text') return block['text'] as String? ?? '';
          if (block['type'] == 'image') return '[图片]';
          return '';
        })
        .where((text) => text.isNotEmpty)
        .join('\n');
  }
  return '';
}

String _clip(String text) =>
    text.length <= _maxOutput ? text : '${text.substring(0, _maxOutput)}\n…（原型里截到 100 KB）';

bool _skipUserText(String text) =>
    text.isEmpty ||
    text.startsWith('<command-') ||
    text.startsWith('<local-command') ||
    text.startsWith('<system-reminder') ||
    text.startsWith('Caveat:') ||
    text.startsWith('[Request interrupted');

void main(List<String> args) {
  if (args.isEmpty) {
    stderr.writeln('用法：dart run tool/convert_claude.dart <会话.jsonl> [输出路径]');
    exit(64);
  }
  final outPath = args.length > 1 ? args[1] : 'assets/session.json';
  final events = <Map<String, Object?>>[];
  final tools = <String, Map<String, Object?>>{};
  var seq = 0;
  var runs = 0;
  String? runId;
  var lastAt = DateTime.now().toUtc().toIso8601String();

  void emit(String type, Object? payload, String at) {
    seq += 1;
    events.add({'seq': seq, 'runId': runId, 'type': type, 'payload': payload, 'createdAt': at});
  }

  for (final line in File(args[0]).readAsLinesSync()) {
    if (line.trim().isEmpty) continue;
    final Object? decoded;
    try {
      decoded = jsonDecode(line);
    } on FormatException {
      continue;
    }
    if (decoded is! Map<String, dynamic>) continue;
    if (decoded['isSidechain'] == true || decoded['isMeta'] == true) continue;
    final message = decoded['message'];
    if (message is! Map) continue;
    final at = decoded['timestamp'] as String? ?? lastAt;
    lastAt = at;
    final content = message['content'];

    if (decoded['type'] == 'user') {
      final texts = <String>[];
      if (content is String) texts.add(content);
      if (content is List) {
        for (final block in content) {
          if (block is! Map) continue;
          if (block['type'] == 'text') texts.add(block['text'] as String? ?? '');
          if (block['type'] == 'tool_result') {
            final id = block['tool_use_id'] as String? ?? '';
            final tool = tools[id];
            emit('tool.completed', {
              'toolCallId': id,
              'name': tool?['name'] ?? 'tool',
              'input': tool?['input'],
              'output': _clip(_resultText(block['content'])),
              'exitCode': block['is_error'] == true ? 1 : 0,
            }, at);
          }
        }
      }
      final text = texts.join('\n').trim();
      if (_skipUserText(text)) continue;
      if (runId != null) emit('run.completed', {}, at);
      runs += 1;
      runId = 'r$runs';
      emit('run.started', {'text': text}, at);
    } else if (decoded['type'] == 'assistant' && content is List) {
      for (final block in content) {
        if (block is! Map) continue;
        switch (block['type']) {
          case 'thinking':
            final text = (block['thinking'] as String? ?? '').trim();
            if (text.isNotEmpty) emit('reasoning.completed', {'text': text}, at);
          case 'text':
            final text = (block['text'] as String? ?? '').trim();
            if (text.isNotEmpty) emit('message.completed', {'role': 'assistant', 'text': text}, at);
          case 'tool_use':
            final id = block['id'] as String? ?? 'tool-$seq';
            tools[id] = {'name': block['name'], 'input': block['input']};
            emit('tool.started', {'toolCallId': id, 'name': block['name'], 'input': block['input']}, at);
        }
      }
    }
  }
  if (runId != null) emit('run.completed', {}, lastAt);

  final out = File(outPath)..createSync(recursive: true);
  out.writeAsStringSync(jsonEncode({'source': 'claude-code-transcript', 'events': events}));
  stdout.writeln('写出 ${events.length} 条事件、$runs 轮到 $outPath（${(out.lengthSync() / 1024).round()} KB）');
}
