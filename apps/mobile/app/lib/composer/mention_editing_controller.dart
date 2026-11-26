import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import 'composer_tokens.dart';

/// 契约 `mobileThreadReferences` 上限（对齐 `command_models.dart` / `draft_models.dart`）。
const mobileThreadReferencesLimit = 10;

/// 输入框中需要高亮渲染的提及片段类型。
enum ComposerHighlightKind { threadReference, fileMention, skill }

/// 输入框高亮区间（左闭右开 `[start, end)`）。
final class ComposerHighlightSpan {
  const ComposerHighlightSpan({
    required this.start,
    required this.end,
    required this.kind,
  });

  final int start;
  final int end;
  final ComposerHighlightKind kind;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ComposerHighlightSpan &&
          other.start == start &&
          other.end == end &&
          other.kind == kind;

  @override
  int get hashCode => Object.hash(start, end, kind);

  @override
  String toString() => 'ComposerHighlightSpan($kind, $start..$end)';
}

const _cjkStopPunctuationChars = <String>{
  '，',
  '。',
  '；',
  '：',
  '！',
  '？',
  '、',
  '（',
  '）',
  '【',
  '】',
  '“',
  '”',
  '‘',
  '’',
};

const _trailingPunctuationChars = <String>{
  ',',
  '.',
  ';',
  ':',
  '!',
  '?',
  ')',
  ']',
  '"',
  "'",
  ..._cjkStopPunctuationChars,
};

final _fileExtensionPattern = RegExp(r'\.[A-Za-z0-9_-]+$');
final _skillTokenPattern = RegExp(
  r'^(?![0-9]+(?:\.[0-9]+)?$)[A-Za-z0-9_\u4E00-\u9FFF][A-Za-z0-9._:/\-\u4E00-\u9FFF]*$',
);

bool _isWhitespaceCodeUnit(int codeUnit) =>
    codeUnit == 0x20 || // space
    codeUnit == 0x09 || // \t
    codeUnit == 0x0A || // \n
    codeUnit == 0x0D || // \r
    codeUnit == 0x0B || // \v
    codeUnit == 0x0C || // \f
    codeUnit == 0x00A0 || // nbsp
    codeUnit == 0x3000; // ideographic space

bool _hasBoundaryBefore(String text, int index) =>
    index == 0 || _isWhitespaceCodeUnit(text.codeUnitAt(index - 1));

bool _hasBoundaryAfter(String text, int end) =>
    end == text.length ||
    _isWhitespaceCodeUnit(text.codeUnitAt(end)) ||
    _trailingPunctuationChars.contains(text[end]);

int _stripTrailingPunctuationEnd(String text, int start, int rawEnd) {
  var end = rawEnd;
  while (end > start && _trailingPunctuationChars.contains(text[end - 1])) {
    end--;
  }
  return end;
}

/// 解析当前文本中仍完整保留在边界内的已跟踪 `@会话标题` 引用：
/// 按文本出现顺序去重，最多返回 [mobileThreadReferencesLimit] 条。
List<MobileThreadReference> resolveTrackedThreadReferences(
  String text,
  Iterable<MobileThreadReference> tracked,
) {
  if (text.isEmpty) return const [];
  final candidates = tracked.where((ref) => ref.title.isNotEmpty).toList()
    ..sort((a, b) => b.title.length.compareTo(a.title.length));
  if (candidates.isEmpty) return const [];

  final seenIds = <String>{};
  final resolved = <MobileThreadReference>[];
  var i = 0;
  while (i < text.length && resolved.length < mobileThreadReferencesLimit) {
    if (text.codeUnitAt(i) == 0x40 && _hasBoundaryBefore(text, i)) {
      MobileThreadReference? matched;
      var matchedEnd = i;
      for (final candidate in candidates) {
        final end = i + 1 + candidate.title.length;
        if (end <= text.length &&
            text.startsWith(candidate.title, i + 1) &&
            _hasBoundaryAfter(text, end)) {
          matched = candidate;
          matchedEnd = end;
          break;
        }
      }
      if (matched != null) {
        if (seenIds.add(matched.threadId)) {
          resolved.add(matched);
        }
        i = matchedEnd;
        continue;
      }
    }
    i++;
  }
  return List<MobileThreadReference>.unmodifiable(resolved);
}

/// 扫描文本中的 `@会话标题`、`@文件路径` 与 `$Skill名称` 高亮区间（严格不重叠、按升序返回）。
List<ComposerHighlightSpan> findComposerHighlightSpans(
  String text, {
  Iterable<MobileThreadReference> threadReferences = const [],
  Iterable<String> fileMentions = const [],
}) {
  if (text.isEmpty) return const [];
  final sortedThreads =
      threadReferences.where((ref) => ref.title.isNotEmpty).toList()
        ..sort((a, b) => b.title.length.compareTo(a.title.length));
  final sortedFiles =
      fileMentions.where((path) => path.isNotEmpty).toSet().toList()
        ..sort((a, b) => b.length.compareTo(a.length));

  final spans = <ComposerHighlightSpan>[];
  var i = 0;
  while (i < text.length) {
    final codeUnit = text.codeUnitAt(i);
    if ((codeUnit == 0x40 || codeUnit == 0x24) && _hasBoundaryBefore(text, i)) {
      if (codeUnit == 0x40) {
        // 1. 已跟踪的 `@会话标题`（允许标题内包含空格，按长度降序优先完整匹配）。
        var matchedThreadEnd = -1;
        for (final ref in sortedThreads) {
          final end = i + 1 + ref.title.length;
          if (end <= text.length &&
              text.startsWith(ref.title, i + 1) &&
              _hasBoundaryAfter(text, end)) {
            matchedThreadEnd = end;
            break;
          }
        }
        if (matchedThreadEnd > i) {
          spans.add(
            ComposerHighlightSpan(
              start: i,
              end: matchedThreadEnd,
              kind: ComposerHighlightKind.threadReference,
            ),
          );
          i = matchedThreadEnd;
          continue;
        }

        // 2. 通过联想面板插入的 `@文件路径`（支持无后缀文件名如 Makefile 或含空格路径）。
        var matchedFileEnd = -1;
        for (final path in sortedFiles) {
          final end = i + 1 + path.length;
          if (end <= text.length &&
              text.startsWith(path, i + 1) &&
              _hasBoundaryAfter(text, end)) {
            matchedFileEnd = end;
            break;
          }
        }
        if (matchedFileEnd > i) {
          spans.add(
            ComposerHighlightSpan(
              start: i,
              end: matchedFileEnd,
              kind: ComposerHighlightKind.fileMention,
            ),
          );
          i = matchedFileEnd;
          continue;
        }

        // 3. 通用 `@文件路径` 模式（避免误伤邮箱 `a@b.com` 及孤立 `@`，遇到中文标点及时截断）。
        var rawEnd = i + 1;
        while (rawEnd < text.length &&
            !_isWhitespaceCodeUnit(text.codeUnitAt(rawEnd)) &&
            text.codeUnitAt(rawEnd) != 0x40 &&
            !_cjkStopPunctuationChars.contains(text[rawEnd])) {
          rawEnd++;
        }
        final tokenEnd = _stripTrailingPunctuationEnd(text, i + 1, rawEnd);
        if (tokenEnd > i + 1) {
          final token = text.substring(i + 1, tokenEnd);
          if (token.contains('/') || _fileExtensionPattern.hasMatch(token)) {
            spans.add(
              ComposerHighlightSpan(
                start: i,
                end: tokenEnd,
                kind: ComposerHighlightKind.fileMention,
              ),
            );
            i = rawEnd;
            continue;
          }
        }
      } else {
        // `$Skill名称`（前面为行首或空白，遇到中文标点截断，排除纯数字价格如 `$100`）。
        var rawEnd = i + 1;
        while (rawEnd < text.length &&
            !_isWhitespaceCodeUnit(text.codeUnitAt(rawEnd)) &&
            text.codeUnitAt(rawEnd) != 0x24 &&
            !_cjkStopPunctuationChars.contains(text[rawEnd])) {
          rawEnd++;
        }
        final tokenEnd = _stripTrailingPunctuationEnd(text, i + 1, rawEnd);
        if (tokenEnd > i + 1) {
          final token = text.substring(i + 1, tokenEnd);
          if (_skillTokenPattern.hasMatch(token)) {
            spans.add(
              ComposerHighlightSpan(
                start: i,
                end: tokenEnd,
                kind: ComposerHighlightKind.skill,
              ),
            );
            i = rawEnd;
            continue;
          }
        }
      }
    }
    i++;
  }
  return List<ComposerHighlightSpan>.unmodifiable(spans);
}

/// 手机端输入框定制控制器：
/// - 实时蓝色高亮 `@会话标题`、`@文件路径` 与 `$Skill名称`（保持完全一致字号/字重/行高，光标零偏移）；
/// - 严格兼容中英文输入法组合输入（IME `value.composing`），绝不破坏组合区下划线或吞字；
/// - 维护结构化会话引用表，发送前按文本边界自动清理已被用户编辑/删除的失效引用。
class ComposerTextEditingController extends TextEditingController {
  ComposerTextEditingController({super.text});

  ComposerTextEditingController.fromValue(super.value) : super.fromValue();

  final Map<String, MobileThreadReference> _threadReferences =
      <String, MobileThreadReference>{};
  final Set<String> _fileMentions = <String>{};

  /// 已记录的会话引用只读视图。
  List<MobileThreadReference> get trackedThreadReferences =>
      List<MobileThreadReference>.unmodifiable(_threadReferences.values);

  /// 记录通过 `@` 联想选中的会话引用。
  void recordThreadReference(MobileThreadReference reference) {
    _threadReferences[reference.threadId] = reference;
  }

  /// 记录通过 `@` 联想选中的文件路径（让无扩展名文件也能保持高亮）。
  void recordFileMention(String path) {
    if (path.isNotEmpty) {
      _fileMentions.add(path);
    }
  }

  /// 清空内部跟踪的会话引用与文件提及记录。
  void clearThreadReferences() {
    _threadReferences.clear();
    _fileMentions.clear();
  }

  /// 解析当前文本（或指定文本）中仍完整存在的有效会话引用列表（按出现顺序去重，最多 10 条）。
  /// 文本中一旦删改 `@会话标题`，对应引用自动剔除，绝不错误携带。
  List<MobileThreadReference> resolveReferences([String? sourceText]) =>
      resolveTrackedThreadReferences(
        sourceText ?? text,
        _threadReferences.values,
      );

  @override
  set value(TextEditingValue newValue) {
    if (newValue.text.isEmpty &&
        (_threadReferences.isNotEmpty || _fileMentions.isNotEmpty)) {
      clearThreadReferences();
    }
    super.value = newValue;
  }

  @override
  void clear() {
    clearThreadReferences();
    super.clear();
  }

  @override
  TextSpan buildTextSpan({
    required BuildContext context,
    TextStyle? style,
    required bool withComposing,
  }) {
    final fullText = value.text;
    final hasComposing =
        withComposing &&
        value.isComposingRangeValid &&
        !value.composing.isCollapsed;
    final spans = findComposerHighlightSpans(
      fullText,
      threadReferences: _threadReferences.values,
      fileMentions: _fileMentions,
    );

    if (spans.isEmpty && !hasComposing) {
      return TextSpan(style: style, text: fullText);
    }

    final brightness = Theme.of(context).brightness;
    final highlightColor = ComposerSurface.mentionHighlight(brightness);
    final highlightStyle = (style ?? const TextStyle()).copyWith(
      color: highlightColor,
    );

    if (!hasComposing) {
      final children = <InlineSpan>[];
      _appendHighlightedRange(
        out: children,
        fullText: fullText,
        rangeStart: 0,
        rangeEnd: fullText.length,
        spans: spans,
        highlightStyle: highlightStyle,
      );
      return TextSpan(style: style, children: children);
    }

    final composingStart = value.composing.start;
    final composingEnd = value.composing.end;
    final composingStyle = (style ?? const TextStyle()).merge(
      const TextStyle(decoration: TextDecoration.underline),
    );
    // 跳过与正在输入组合区重叠的片段，绝不在 IME 组合期间切碎或改写组合区。
    final safeSpans = spans
        .where(
          (span) => span.end <= composingStart || span.start >= composingEnd,
        )
        .toList();

    final children = <InlineSpan>[];
    if (composingStart > 0) {
      _appendHighlightedRange(
        out: children,
        fullText: fullText,
        rangeStart: 0,
        rangeEnd: composingStart,
        spans: safeSpans,
        highlightStyle: highlightStyle,
      );
    }
    children.add(
      TextSpan(
        style: composingStyle,
        text: fullText.substring(composingStart, composingEnd),
      ),
    );
    if (composingEnd < fullText.length) {
      _appendHighlightedRange(
        out: children,
        fullText: fullText,
        rangeStart: composingEnd,
        rangeEnd: fullText.length,
        spans: safeSpans,
        highlightStyle: highlightStyle,
      );
    }
    return TextSpan(style: style, children: children);
  }

  void _appendHighlightedRange({
    required List<InlineSpan> out,
    required String fullText,
    required int rangeStart,
    required int rangeEnd,
    required List<ComposerHighlightSpan> spans,
    required TextStyle highlightStyle,
  }) {
    var cursor = rangeStart;
    for (final span in spans) {
      if (span.end <= rangeStart) continue;
      if (span.start >= rangeEnd) break;
      final start = span.start < rangeStart ? rangeStart : span.start;
      final end = span.end > rangeEnd ? rangeEnd : span.end;
      if (start > cursor) {
        out.add(TextSpan(text: fullText.substring(cursor, start)));
      }
      if (end > start) {
        out.add(
          TextSpan(text: fullText.substring(start, end), style: highlightStyle),
        );
      }
      cursor = end;
    }
    if (cursor < rangeEnd) {
      out.add(TextSpan(text: fullText.substring(cursor, rangeEnd)));
    }
  }
}
