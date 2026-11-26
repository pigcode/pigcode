import 'package:pigcode_client/pigcode_client.dart';

import '../timeline_work.dart';

/// 手机端本机预览允许访问的 loopback 主机名白名单（严格字面量匹配，与电脑端 Host 一致）。
const mobilePreviewAllowedHosts = <String>{'localhost', '127.0.0.1', '[::1]'};

/// 禁止通过本机预览隧道探测的常见非 HTTP 基础服务端口（与电脑端 Host 一致）。
const mobilePreviewBlockedPorts = <int>{
  22,
  23,
  25,
  53,
  110,
  143,
  445,
  587,
  993,
  995,
  1433,
  1521,
  3306,
  3389,
  5432,
  6379,
  9200,
  11211,
  27017,
};

final _pureDigitsPattern = RegExp(r'^\d+$');
final _leadingPortPattern = RegExp(r'^:\d+(?:[/?#].*)?$');
final _controlOrSpacePattern = RegExp(r'[\x00-\x1f\x7f\s]');
final _schemeAuthorityPattern = RegExp(
  r'^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#\\]*)(?:[/?#]|$)',
);
final _nonHttpSchemePattern = RegExp(r'^[a-zA-Z][a-zA-Z0-9+.-]*:');
final _bareLoopbackPrefixPattern = RegExp(
  r'^(?:localhost|127\.0\.0\.1|\[::1\])(?=$|[:/?#])',
  caseSensitive: false,
);
final _ipv6LoopbackAuthorityPattern = RegExp(
  r'^(\[::1\])(?::(\d+))?$',
  caseSensitive: false,
);
final _hostPortAuthorityPattern = RegExp(r'^([^:]+)(?::(\d+))?$');

/// 时间线文本中可提取的本机 HTTP/HTTPS 预览地址匹配模式（要求带显式端口）。
final _extractableLocalhostUrlPattern = RegExp(
  r'https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}(?:[^\s<>"`'
  '\u3000\u3001\u3002\uFF0C\uFF1B\uFF1A\uFF01\uFF1F\uFF09\u3011\u300B\u300D\u300F\u201D\u2019]*)',
  caseSensitive: false,
);

const _alwaysStripTrailingChars = <String>{
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  "'",
  '"',
  '`',
  '>',
  '、',
  '。',
  '，',
  '；',
  '：',
  '！',
  '？',
  '）',
  '】',
  '》',
  '」',
  '』',
  '”',
  '’',
};

/// 预览地址规范化与校验结果。
final class PreviewUrlValidationResult {
  const PreviewUrlValidationResult.ok(Uri this.uri) : error = null;
  const PreviewUrlValidationResult.error(String this.error) : uri = null;

  final Uri? uri;
  final String? error;

  bool get isValid => uri != null;
}

/// 规范化并严格校验用户输入的本机预览地址：
/// - 纯端口号（如 `5173`）自动补全为 `http://localhost:5173/`；
/// - 省略协议的本机地址（如 `localhost:3000/app`）自动补全为 `http://localhost:3000/app`；
/// - 仅允许 `http` / `https` 且主机字面量为 `localhost` / `127.0.0.1` / `[::1]`，
///   拦截外部域名、局域网/变形 IP、用户信息与常见非 HTTP 端口。
PreviewUrlValidationResult normalizePreviewInput(String raw) {
  final trimmed = raw.trim();
  if (trimmed.isEmpty) {
    return const PreviewUrlValidationResult.error('请输入本机端口号或 localhost 地址');
  }

  if (_pureDigitsPattern.hasMatch(trimmed)) {
    final port = int.tryParse(trimmed);
    if (port == null || port < 1 || port > 65535) {
      return const PreviewUrlValidationResult.error('端口号需在 1 到 65535 之间');
    }
    if (mobilePreviewBlockedPorts.contains(port)) {
      return PreviewUrlValidationResult.error('端口 $port 不支持用于网页预览');
    }
    return PreviewUrlValidationResult.ok(
      Uri(scheme: 'http', host: 'localhost', port: port, path: '/'),
    );
  }

  String candidate;
  if (_leadingPortPattern.hasMatch(trimmed)) {
    candidate = 'http://localhost$trimmed';
  } else if (trimmed.contains('://')) {
    candidate = trimmed;
  } else if (_bareLoopbackPrefixPattern.hasMatch(trimmed)) {
    candidate = 'http://$trimmed';
  } else if (_nonHttpSchemePattern.hasMatch(trimmed)) {
    return const PreviewUrlValidationResult.error('仅支持 http 或 https 协议的本机地址');
  } else {
    candidate = 'http://$trimmed';
  }

  return _validateLoopbackHttpUrl(candidate);
}

PreviewUrlValidationResult _validateLoopbackHttpUrl(String rawUrl) {
  if (rawUrl.isEmpty || rawUrl.length > mobilePreviewUrlMax) {
    return const PreviewUrlValidationResult.error('预览地址长度超出限制');
  }
  if (_controlOrSpacePattern.hasMatch(rawUrl)) {
    return const PreviewUrlValidationResult.error('预览地址格式不正确，不能包含空格或控制字符');
  }

  final schemeMatch = _schemeAuthorityPattern.firstMatch(rawUrl);
  if (schemeMatch == null) {
    return const PreviewUrlValidationResult.error('请输入有效的本机 HTTP/HTTPS 地址');
  }

  final scheme = schemeMatch.group(1)!.toLowerCase();
  if (scheme != 'http' && scheme != 'https') {
    return const PreviewUrlValidationResult.error('仅支持 http 或 https 协议的本机地址');
  }

  final authority = schemeMatch.group(2) ?? '';
  if (authority.isEmpty) {
    return const PreviewUrlValidationResult.error('请输入有效的本机地址');
  }
  if (authority.contains('@')) {
    return const PreviewUrlValidationResult.error('本机预览地址不支持包含用户名或密码');
  }

  final String rawHost;
  final String? rawPort;
  if (authority.startsWith('[')) {
    final ipv6Match = _ipv6LoopbackAuthorityPattern.firstMatch(authority);
    if (ipv6Match == null) {
      return const PreviewUrlValidationResult.error(
        '仅允许访问电脑本机 localhost、127.0.0.1 或 [::1] 地址',
      );
    }
    rawHost = ipv6Match.group(1)!.toLowerCase();
    rawPort = ipv6Match.group(2);
  } else {
    final hostMatch = _hostPortAuthorityPattern.firstMatch(authority);
    if (hostMatch == null) {
      return const PreviewUrlValidationResult.error(
        '仅允许访问电脑本机 localhost、127.0.0.1 或 [::1] 地址',
      );
    }
    rawHost = hostMatch.group(1)!.toLowerCase();
    rawPort = hostMatch.group(2);
  }

  if (!mobilePreviewAllowedHosts.contains(rawHost)) {
    return const PreviewUrlValidationResult.error(
      '仅允许访问电脑本机 localhost、127.0.0.1 或 [::1] 地址',
    );
  }

  if (rawPort != null) {
    final explicitPort = int.tryParse(rawPort);
    if (explicitPort == null || explicitPort < 1 || explicitPort > 65535) {
      return const PreviewUrlValidationResult.error('端口号需在 1 到 65535 之间');
    }
  }

  final parsed = Uri.tryParse(rawUrl);
  if (parsed == null ||
      (parsed.scheme != 'http' && parsed.scheme != 'https') ||
      parsed.userInfo.isNotEmpty) {
    return const PreviewUrlValidationResult.error('请输入有效的本机 HTTP/HTTPS 地址');
  }

  final parsedHost = parsed.host.toLowerCase();
  final canonicalHost = parsedHost == '::1' ? '[::1]' : parsedHost;
  if (!mobilePreviewAllowedHosts.contains(canonicalHost)) {
    return const PreviewUrlValidationResult.error(
      '仅允许访问电脑本机 localhost、127.0.0.1 或 [::1] 地址',
    );
  }

  final effectivePort = parsed.hasPort
      ? parsed.port
      : (parsed.scheme == 'https' ? 443 : 80);
  if (effectivePort < 1 || effectivePort > 65535) {
    return const PreviewUrlValidationResult.error('端口号需在 1 到 65535 之间');
  }
  if (mobilePreviewBlockedPorts.contains(effectivePort)) {
    return PreviewUrlValidationResult.error('端口 $effectivePort 不支持用于网页预览');
  }

  final normalized = parsed.path.isEmpty ? parsed.replace(path: '/') : parsed;
  return PreviewUrlValidationResult.ok(normalized);
}

/// 判断时间线中的链接是否属于可走本机预览隧道的 `http(s)://(localhost|127.0.0.1|[::1])` URL。
bool isLocalhostPreviewUrl(String raw) {
  final trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith('http://') &&
      !trimmed.toLowerCase().startsWith('https://')) {
    return false;
  }
  return _validateLoopbackHttpUrl(trimmed).isValid;
}

/// 清洗从自由文本中匹配到的 URL 末尾中英文标点与未配对括号。
String _cleanExtractedUrl(String raw) {
  var value = raw;
  while (value.isNotEmpty) {
    final last = value[value.length - 1];
    if (_alwaysStripTrailingChars.contains(last)) {
      value = value.substring(0, value.length - 1);
      continue;
    }
    if (last == ')' && _countChar(value, '(') < _countChar(value, ')')) {
      value = value.substring(0, value.length - 1);
      continue;
    }
    if (last == ']' && _countChar(value, '[') < _countChar(value, ']')) {
      value = value.substring(0, value.length - 1);
      continue;
    }
    if (last == '}' && _countChar(value, '{') < _countChar(value, '}')) {
      value = value.substring(0, value.length - 1);
      continue;
    }
    break;
  }
  return value;
}

int _countChar(String input, String char) {
  var count = 0;
  for (var i = 0; i < input.length; i++) {
    if (input[i] == char) count++;
  }
  return count;
}

/// 按时间正序扫描片段文本，按最新出现倒序去重。
List<String> _extractUrlsFromOrderedTexts(Iterable<String> texts) {
  final ordered = <String>[];
  for (final rawText in texts) {
    if (rawText.isEmpty) continue;
    final cleanText = timelineStripAnsi(rawText);
    for (final match in _extractableLocalhostUrlPattern.allMatches(cleanText)) {
      final candidate = _cleanExtractedUrl(match.group(0)!);
      final validated = _validateLoopbackHttpUrl(candidate);
      if (validated.uri case final uri?) {
        final canonical = uri.toString();
        ordered.remove(canonical);
        ordered.insert(0, canonical);
      }
    }
  }
  return List<String>.unmodifiable(ordered);
}

/// 从单段文本（如助手回复或终端工具输出）提取本机预览 URL，清洗末尾标点并按最新出现倒序去重。
List<String> extractPreviewUrlsFromText(String text) =>
    _extractUrlsFromOrderedTexts([text]);

/// 从会话时间线各轮次的助手回复与工具输出提取本机预览 URL，按最新出现倒序去重。
List<String> extractPreviewUrlsFromTurns(List<TimelineTurn> turns) {
  final texts = <String>[];
  for (final turn in turns) {
    for (final item in turn.work) {
      if (item.kind == TimelineWorkKind.message) {
        if (item.event.text case final text? when text.isNotEmpty) {
          texts.add(text);
        }
      } else if (item.kind == TimelineWorkKind.tool) {
        if (item.output?.text case final output? when output.isNotEmpty) {
          texts.add(output);
        }
      }
    }
    if (turn.answer?.text case final answer? when answer.isNotEmpty) {
      texts.add(answer);
    }
  }
  return _extractUrlsFromOrderedTexts(texts);
}

/// 从完整时间线快照（含正在流式输出的回复与工具输出）提取本机预览 URL，按最新出现倒序去重。
List<String> extractPreviewUrlsFromSnapshot(TimelineSnapshot? snapshot) {
  if (snapshot == null) return const [];
  final texts = <String>[];
  for (final turn in timelineTurns(snapshot.events)) {
    for (final item in turn.work) {
      if (item.kind == TimelineWorkKind.message) {
        if (item.event.text case final text? when text.isNotEmpty) {
          texts.add(text);
        }
      } else if (item.kind == TimelineWorkKind.tool) {
        if (item.output?.text case final output? when output.isNotEmpty) {
          texts.add(output);
        }
      }
    }
    if (turn.answer?.text case final answer? when answer.isNotEmpty) {
      texts.add(answer);
    }
  }
  if (snapshot.live case final live?) {
    for (final tool in live.tools) {
      if (tool.text.isNotEmpty) texts.add(tool.text);
    }
    if (live.text.isNotEmpty) texts.add(live.text);
  }
  return _extractUrlsFromOrderedTexts(texts);
}

/// 将本机预览 URI 格式化为顶栏/列表展示用的友好地址（如 `localhost:5173/dashboard`、`localhost:5173`）。
String formatPreviewDisplayAddress(Uri uri) {
  final host = uri.host.contains(':') ? '[${uri.host}]' : uri.host;
  final isDefaultPort =
      !uri.hasPort ||
      (uri.scheme == 'http' && uri.port == 80) ||
      (uri.scheme == 'https' && uri.port == 443);
  final authority = isDefaultPort ? host : '$host:${uri.port}';
  final prefix = uri.scheme == 'https' ? 'https://' : '';
  final hasQueryOrFragment = uri.hasQuery || uri.hasFragment;
  final path = (uri.path.isEmpty || (uri.path == '/' && !hasQueryOrFragment))
      ? ''
      : uri.path;
  final query = uri.hasQuery ? '?${uri.query}' : '';
  final fragment = uri.hasFragment ? '#${uri.fragment}' : '';
  return '$prefix$authority$path$query$fragment';
}
