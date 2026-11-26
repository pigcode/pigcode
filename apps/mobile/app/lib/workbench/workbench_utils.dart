import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';
import 'package:re_highlight/languages/all.dart';
import 'package:re_highlight/re_highlight.dart';
import 'package:re_highlight/styles/atom-one-dark.dart';
import 'package:re_highlight/styles/atom-one-light.dart';
import 'package:url_launcher/url_launcher.dart';

import '../mobile_glass.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';

/// 点击时间线中的 `@文件路径` 或工具文件芯片时触发的只读源码打开回调。
typedef TimelineOpenFileCallback =
    Future<void> Function(String path, {int? line});

/// 点击时间线 Markdown 链接时的回调。
typedef TimelineOpenLinkCallback = void Function(String url, String title);

/// 外部浏览器打开链接函数（便于在测试中注入替身验证）。
typedef ExternalUrlOpener = Future<bool> Function(Uri uri);

/// 默认使用 `url_launcher` 在系统外部浏览器中打开链接。
Future<bool> launchExternalUrl(Uri uri) =>
    launchUrl(uri, mode: LaunchMode.externalApplication);

enum _ExternalLinkDialogAction { cancel, copy, open }

/// 弹窗确认后在系统外部浏览器打开 HTTP/HTTPS 链接，并附带复制链接选项。
Future<void> confirmAndOpenExternalUrl(
  BuildContext context,
  Uri uri, {
  ExternalUrlOpener? openExternalUrl,
  String title = '打开外部链接',
  String message = '即将在系统浏览器中打开以下外部链接：',
}) async {
  final scheme = uri.scheme.toLowerCase();
  if (scheme != 'http' && scheme != 'https') {
    await Clipboard.setData(ClipboardData(text: uri.toString()));
    if (!context.mounted) return;
    ScaffoldMessenger.maybeOf(
      context,
    )?.showSnackBar(SnackBar(content: Text('已复制链接 ${uri.toString()}')));
    return;
  }

  final action = await showDialog<_ExternalLinkDialogAction>(
    context: context,
    builder: (dialogContext) {
      final colors = Theme.of(dialogContext).brightness == Brightness.dark
          ? pigcodeDark
          : pigcodeLight;
      return MobileGlassDialog(
        title: Text(title),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          spacing: TimelineSpace.x4,
          children: [
            Text(message),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(TimelineSpace.x4),
              decoration: BoxDecoration(
                color: colors.field,
                borderRadius: BorderRadius.circular(TimelineRadius.block),
                border: Border.all(color: colors.border),
              ),
              child: Text(
                uri.toString(),
                style: TimelineType.metaMonoStyle(colors.secondaryText),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(
              dialogContext,
            ).pop(_ExternalLinkDialogAction.cancel),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () =>
                Navigator.of(dialogContext).pop(_ExternalLinkDialogAction.copy),
            child: const Text('复制链接'),
          ),
          FilledButton(
            onPressed: () =>
                Navigator.of(dialogContext).pop(_ExternalLinkDialogAction.open),
            child: const Text('在浏览器打开'),
          ),
        ],
      );
    },
  );

  if (!context.mounted) return;
  switch (action) {
    case _ExternalLinkDialogAction.copy:
      await Clipboard.setData(ClipboardData(text: uri.toString()));
      if (!context.mounted) return;
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text('已复制链接 ${uri.toString()}')));
    case _ExternalLinkDialogAction.open:
      final opener = openExternalUrl ?? launchExternalUrl;
      var opened = false;
      try {
        opened = await opener(uri);
      } catch (_) {
        opened = false;
      }
      if (!context.mounted || opened) return;
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(const SnackBar(content: Text('无法在外部浏览器打开此链接')));
    case _ExternalLinkDialogAction.cancel || null:
      break;
  }
}

/// 读取 `connection.supportsWorkbenchRead`；在未覆写该属性的旧版桩连接上安全降级为 `false`。
bool connectionSupportsWorkbenchRead(MobileConnection? connection) {
  if (connection == null) return false;
  try {
    return connection.supportsWorkbenchRead;
  } on NoSuchMethodError {
    return false;
  }
}

/// 读取 `connection.supportsPreviewTunnel`；在未覆写该属性的旧版桩连接上安全降级为 `false`。
bool connectionSupportsPreviewTunnel(MobileConnection? connection) {
  if (connection == null) return false;
  try {
    return connection.supportsPreviewTunnel;
  } on NoSuchMethodError {
    return false;
  }
}

/// 读取 `connection.supportsWorkbenchWrite`；在未覆写该属性的旧版桩连接上安全降级为 `false`。
bool connectionSupportsWorkbenchWrite(MobileConnection? connection) {
  if (connection == null) return false;
  try {
    return connection.supportsWorkbenchWrite;
  } on NoSuchMethodError {
    return false;
  }
}

/// 读取 `connection.supportsTerminal`；在未覆写该属性的旧版桩连接上安全降级为 `false`。
bool connectionSupportsTerminal(MobileConnection? connection) {
  if (connection == null) return false;
  try {
    return connection.supportsTerminal;
  } on NoSuchMethodError {
    return false;
  }
}

/// 安全读取连接关联的 `computerKey`；在未覆写 `computer` 的旧版测试桩上返回 `null`。
String? connectionComputerKey(MobileConnection? connection) {
  if (connection == null) return null;
  try {
    return connection.computer.computerKey;
  } on NoSuchMethodError {
    return null;
  }
}

final _lineSuffixPattern = RegExp(r'^(.+?):(\d+)(?::\d+)?$');
final _hashLineSuffixPattern = RegExp(r'^(.+?)#L(\d+)(?:-L?\d+)?$');
final _windowsDrivePattern = RegExp(r'^[a-zA-Z]:/');

/// 解析文件引用，兼容 `@lib/main.dart:42`、`lib/main.dart:42:8`、`lib/main.dart#L42` 等格式。
({String path, int? line}) parseFileReference(String raw) {
  var value = raw.trim();
  if (value.startsWith('@')) {
    value = value.substring(1).trim();
  }
  value = value.replaceAll('\\', '/');

  int? line;
  if (_lineSuffixPattern.firstMatch(value) case final match?) {
    final candidatePath = match.group(1)!;
    final parsed = int.tryParse(match.group(2)!);
    if (candidatePath.isNotEmpty && parsed != null && parsed > 0) {
      value = candidatePath;
      line = parsed;
    }
  } else if (_hashLineSuffixPattern.firstMatch(value) case final match?) {
    final candidatePath = match.group(1)!;
    final parsed = int.tryParse(match.group(2)!);
    if (candidatePath.isNotEmpty && parsed != null && parsed > 0) {
      value = candidatePath;
      line = parsed;
    }
  }

  while (value.startsWith('./') && value.length > 2) {
    value = value.substring(2);
  }
  return (path: value, line: line);
}

/// 判断路径是否指向项目外的绝对路径或越界路径，用于给出更清晰的中文提示。
bool isLikelyOutsideProjectPath(String path) {
  final normalized = path.trim().replaceAll('\\', '/');
  if (normalized.isEmpty) return false;
  if (normalized.startsWith('/') ||
      normalized.startsWith('~') ||
      _windowsDrivePattern.hasMatch(normalized)) {
    return true;
  }
  return normalized.split('/').contains('..');
}

/// 将字节数格式化为易读的文件大小（如 `512 B`、`3.2 KB`、`1.4 MB`）。
String formatFileSize(int bytes) {
  if (bytes < 0) return '0 B';
  if (bytes < 1024) return '$bytes B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  var value = bytes / 1024;
  var unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  final formatted = value >= 100
      ? value.toStringAsFixed(0)
      : value.toStringAsFixed(1).replaceFirst(RegExp(r'\.0$'), '');
  return '$formatted ${units[unitIndex]}';
}

String fileBaseName(String path) {
  final normalized = path.replaceAll('\\', '/');
  final trimmed = normalized.endsWith('/') && normalized.length > 1
      ? normalized.substring(0, normalized.length - 1)
      : normalized;
  final slash = trimmed.lastIndexOf('/');
  return slash < 0 ? trimmed : trimmed.substring(slash + 1);
}

String fileParentDir(String path) {
  final normalized = path.replaceAll('\\', '/');
  final trimmed = normalized.endsWith('/') && normalized.length > 1
      ? normalized.substring(0, normalized.length - 1)
      : normalized;
  final slash = trimmed.lastIndexOf('/');
  return slash <= 0 ? '' : trimmed.substring(0, slash);
}

String _fileExtension(String path) {
  final name = fileBaseName(path).toLowerCase();
  final dot = name.lastIndexOf('.');
  if (dot <= 0 || dot == name.length - 1) return '';
  return name.substring(dot + 1);
}

const _markdownExtensions = <String>{'md', 'markdown', 'mdx'};

const _imageExtensions = <String>{
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'avif',
  'heic',
};

const _codeExtensions = <String>{
  'dart',
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'go',
  'rs',
  'py',
  'rb',
  'php',
  'java',
  'kt',
  'kts',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'cs',
  'sh',
  'bash',
  'zsh',
  'fish',
  'sql',
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'xml',
  'svg',
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'vue',
  'svelte',
  'proto',
  'graphql',
  'gql',
  'dockerfile',
  'makefile',
  'cmake',
  'gradle',
};

bool isMarkdownPath(String path) =>
    _markdownExtensions.contains(_fileExtension(path));

bool isImagePath(String path) =>
    _imageExtensions.contains(_fileExtension(path));

bool isCodePath(String path) {
  final ext = _fileExtension(path);
  if (_codeExtensions.contains(ext)) return true;
  final lowerName = fileBaseName(path).toLowerCase();
  return lowerName == 'dockerfile' ||
      lowerName == 'makefile' ||
      lowerName == 'cmakelists.txt';
}

WorkspaceGlyph workbenchFileGlyph(String path, {bool isDirectory = false}) {
  if (isDirectory) return WorkspaceGlyph.folder;
  if (isImagePath(path)) return WorkspaceGlyph.image;
  if (isCodePath(path)) return WorkspaceGlyph.fileCode;
  return WorkspaceGlyph.fileText;
}

final Highlight _workbenchHighlight = Highlight()
  ..registerLanguages(builtinAllLanguages);

const _languageAliases = <String, String>{
  'ts': 'typescript',
  'tsx': 'typescript',
  'mts': 'typescript',
  'cts': 'typescript',
  'js': 'javascript',
  'jsx': 'javascript',
  'mjs': 'javascript',
  'cjs': 'javascript',
  'py': 'python',
  'rs': 'rust',
  'kt': 'kotlin',
  'kts': 'kotlin',
  'rb': 'ruby',
  'cs': 'csharp',
  'sh': 'bash',
  'shell': 'bash',
  'zsh': 'bash',
  'yml': 'yaml',
  'md': 'markdown',
  'mdx': 'markdown',
  'jsonc': 'json',
  'json5': 'json',
  'htm': 'xml',
  'html': 'xml',
  'svg': 'xml',
  'proto': 'protobuf',
  'gql': 'graphql',
  'cc': 'cpp',
  'cxx': 'cpp',
  'hpp': 'cpp',
  'h': 'c',
};

/// 将 Host 提供的 `languageHint` 或文件扩展名解析为 `re_highlight` 支持的语言标识。
String? resolveHighlightLanguage(String? languageHint, String path) {
  String? tryResolve(String? raw) {
    if (raw == null) return null;
    final key = raw.trim().toLowerCase();
    if (key.isEmpty) return null;
    if (_workbenchHighlight.getLanguage(key) != null) return key;
    final mapped = _languageAliases[key];
    if (mapped != null && _workbenchHighlight.getLanguage(mapped) != null) {
      return mapped;
    }
    return null;
  }

  final fromHint = tryResolve(languageHint);
  if (fromHint != null) return fromHint;
  final ext = _fileExtension(path);
  final fromExt = tryResolve(ext);
  if (fromExt != null) return fromExt;
  final lowerName = fileBaseName(path).toLowerCase();
  if (lowerName == 'dockerfile') return tryResolve('dockerfile');
  if (lowerName == 'makefile') return tryResolve('makefile');
  return null;
}

const _maxHighlightChars = 256 * 1024;

/// 对整段源码做 `re_highlight` 语法高亮并按行拆分为独立的 `TextSpan`，
/// 保证跨行注释/字符串样式在逐行渲染时依然连贯，同时避免超大文本阻塞主线程。
List<TextSpan> highlightCodeLines({
  required String code,
  required String? language,
  required TextStyle baseStyle,
  required Brightness brightness,
}) {
  final normalized = code.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  final rawLines = normalized.split('\n');
  if (language == null ||
      language.isEmpty ||
      normalized.isEmpty ||
      normalized.length > _maxHighlightChars ||
      _workbenchHighlight.getLanguage(language) == null) {
    return [
      for (final line in rawLines)
        TextSpan(text: line.isEmpty ? ' ' : line, style: baseStyle),
    ];
  }

  final renderer = TextSpanRenderer(
    baseStyle,
    brightness == Brightness.dark ? atomOneDarkTheme : atomOneLightTheme,
  );
  _workbenchHighlight
      .highlight(code: normalized, language: language)
      .render(renderer);
  final root = renderer.span;
  if (root == null) {
    return [
      for (final line in rawLines)
        TextSpan(text: line.isEmpty ? ' ' : line, style: baseStyle),
    ];
  }
  final split = splitTextSpanByLines(root, baseStyle);
  if (split.length != rawLines.length) {
    return [
      for (var i = 0; i < rawLines.length; i++)
        i < split.length
            ? split[i]
            : TextSpan(
                text: rawLines[i].isEmpty ? ' ' : rawLines[i],
                style: baseStyle,
              ),
    ];
  }
  return split;
}

/// 将任意嵌套的 `TextSpan` 树按 `\n` 拆分为逐行 `TextSpan` 列表，保留祖先样式继承。
List<TextSpan> splitTextSpanByLines(TextSpan root, TextStyle baseStyle) {
  final lines = <List<InlineSpan>>[<InlineSpan>[]];

  void visit(TextSpan span, TextStyle inherited) {
    final effective = span.style == null
        ? inherited
        : inherited.merge(span.style);
    final text = span.text;
    if (text != null && text.isNotEmpty) {
      final parts = text.split('\n');
      for (var i = 0; i < parts.length; i++) {
        if (i > 0) lines.add(<InlineSpan>[]);
        if (parts[i].isNotEmpty) {
          lines.last.add(TextSpan(text: parts[i], style: effective));
        }
      }
    }
    final children = span.children;
    if (children != null) {
      for (final child in children) {
        if (child is TextSpan) {
          visit(child, effective);
        } else {
          lines.last.add(child);
        }
      }
    }
  }

  visit(root, baseStyle);
  return [
    for (final children in lines)
      children.isEmpty
          ? TextSpan(text: ' ', style: baseStyle)
          : TextSpan(style: baseStyle, children: children),
  ];
}

/// 将工作台 RPC / 连接异常映射为清晰的中文错误文案。
String workbenchErrorMessage(
  Object error, {
  String? path,
  String fallback = '暂时无法读取，请稍后重试。',
}) {
  if (error is MobileRpcFailure) {
    final problem = error.problem;
    switch (problem.code) {
      case 'INVALID_PARAMS':
        if (path != null && isLikelyOutsideProjectPath(path)) {
          return '该文件不在当前项目目录内，无法预览。';
        }
        return '文件路径无效或超出项目范围，无法访问。';
      case 'RESOURCE_NOT_AVAILABLE':
        return '文件或目录不存在，或当前会话项目不可用。';
      case 'ATTACHMENT_TOO_LARGE':
        return '图片文件过大，暂不支持预览。';
      case 'ATTACHMENT_UNSUPPORTED_TYPE':
        return '暂不支持预览此图片格式。';
      case 'METHOD_NOT_AVAILABLE':
        return '请更新电脑上的 Pigcode 后使用工作台。';
      case 'RESULT_TOO_LARGE':
        return '内容过大，暂时无法加载。';
      case 'WORKBENCH_FILE_CONFLICT':
        return '电脑上的文件已被修改，请重新加载或确认覆盖。';
      case 'WORKBENCH_PATH_EXISTS':
        return '目标文件或目录已存在。';
      case 'WORKBENCH_PATH_FORBIDDEN':
        return '路径受保护或超出工作区范围，无法写入。';
      case 'WORKBENCH_DIR_NOT_EMPTY':
        return '目录非空，请确认是否删除目录及其全部内容。';
      case 'WORKBENCH_FILE_TOO_LARGE':
        return '文件内容超出手机端可保存的大小上限。';
      case 'WORKBENCH_WRITE_SESSION_NOT_FOUND':
        return '文件保存会话已过期，请重试保存。';
      case 'WORKBENCH_HASH_MISMATCH':
        return '文件传输校验失败，请重试保存。';
      case 'PR_ACTION_FAILED':
        return '执行 GitHub PR 操作失败，请检查仓库、权限或合并冲突。';
      case 'THREAD_BUSY':
        return '当前会话正在运行中，请等这一轮结束后再操作。';
      case 'TERMINAL_NOT_FOUND':
        return '这个终端已关闭或不再可用。';
      case 'TERMINAL_READ_ONLY':
        return '电脑端打开的终端在手机上仅支持只读查看。';
      case 'TERMINAL_LIMIT_EXCEEDED':
        return '当前会话手机端同时打开的终端数量已达上限。';
    }
    if (problem.message.trim().isNotEmpty) {
      return problem.message;
    }
    return fallback;
  }
  if (error is ConnectionFailure) {
    if (error.code == 'update-desktop') {
      return '请更新电脑上的 Pigcode 后使用工作台。';
    }
    return '电脑连接已断开，请重连后再试。';
  }
  if (error is TimeoutException) {
    return '请求超时，请检查电脑连接后重试。';
  }
  return fallback;
}

/// 按行号总数计算左侧等宽行号栏宽度。
double lineNumberGutterWidth(int lineCount, TextScaler scaler) {
  final digits = math.max(3, lineCount.toString().length);
  return math.max(40.0, scaler.scale(digits * 7.6 + 18));
}
