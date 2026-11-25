import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

import 'preview_url_extractor.dart';

const _hopByHopHeaders = <String>{
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
};

/// 本地回环预览代理上报的结构化错误类型。
enum PreviewProxyErrorKind {
  disabled,
  unreachable,
  timeout,
  urlNotAllowed,
  tooLarge,
  streamNotFound,
  disconnected,
  updateDesktop,
  unknown,
}

/// 预览代理在转发请求或读取响应流时捕获到的结构化错误，供预览页渲染原生中文错误态。
final class PreviewProxyError {
  const PreviewProxyError({
    required this.kind,
    required this.statusCode,
    required this.message,
    this.code,
    this.requestUri,
    this.isDocumentRequest = false,
  });

  final PreviewProxyErrorKind kind;
  final int statusCode;
  final String message;
  final String? code;
  final Uri? requestUri;
  final bool isDocumentRequest;

  bool get isGlobalFailure => switch (kind) {
    PreviewProxyErrorKind.disabled ||
    PreviewProxyErrorKind.unreachable ||
    PreviewProxyErrorKind.timeout ||
    PreviewProxyErrorKind.urlNotAllowed ||
    PreviewProxyErrorKind.disconnected ||
    PreviewProxyErrorKind.updateDesktop => true,
    PreviewProxyErrorKind.tooLarge ||
    PreviewProxyErrorKind.streamNotFound ||
    PreviewProxyErrorKind.unknown => isDocumentRequest,
  };
}

/// 将 Host RPC / 传输异常映射为结构化 [PreviewProxyError]（含对应 HTTP 状态码与中文文案）。
PreviewProxyError previewErrorFromException(
  Object error, {
  Uri? requestUri,
  bool isDocumentRequest = false,
}) {
  if (error is MobileRpcFailure) {
    final code = error.problem.code;
    return switch (code) {
      'PREVIEW_DISABLED' => PreviewProxyError(
        kind: PreviewProxyErrorKind.disabled,
        statusCode: HttpStatus.serviceUnavailable,
        message: '电脑端已关闭手机本机预览，请在电脑「设置 → 手机连接」中开启。',
        code: code,
        requestUri: requestUri,
        isDocumentRequest: isDocumentRequest,
      ),
      'PREVIEW_UNREACHABLE' => PreviewProxyError(
        kind: PreviewProxyErrorKind.unreachable,
        statusCode: HttpStatus.badGateway,
        message: '无法连接电脑上的本机服务，请确认开发服务器已启动。',
        code: code,
        requestUri: requestUri,
        isDocumentRequest: isDocumentRequest,
      ),
      'PREVIEW_TIMEOUT' => PreviewProxyError(
        kind: PreviewProxyErrorKind.timeout,
        statusCode: HttpStatus.gatewayTimeout,
        message: '本机预览请求超时，请检查电脑上的服务是否正常响应。',
        code: code,
        requestUri: requestUri,
        isDocumentRequest: isDocumentRequest,
      ),
      'PREVIEW_URL_NOT_ALLOWED' => PreviewProxyError(
        kind: PreviewProxyErrorKind.urlNotAllowed,
        statusCode: HttpStatus.forbidden,
        message: '仅允许预览电脑本机 localhost HTTP/HTTPS 地址。',
        code: code,
        requestUri: requestUri,
        isDocumentRequest: isDocumentRequest,
      ),
      'PREVIEW_TOO_LARGE' => PreviewProxyError(
        kind: PreviewProxyErrorKind.tooLarge,
        statusCode: HttpStatus.badGateway,
        message: '预览响应或请求超出大小上限，暂时无法加载。',
        code: code,
        requestUri: requestUri,
        isDocumentRequest: isDocumentRequest,
      ),
      'PREVIEW_STREAM_NOT_FOUND' => PreviewProxyError(
        kind: PreviewProxyErrorKind.streamNotFound,
        statusCode: HttpStatus.badGateway,
        message: '预览响应流已过期或关闭，请刷新重试。',
        code: code,
        requestUri: requestUri,
        isDocumentRequest: isDocumentRequest,
      ),
      'METHOD_NOT_AVAILABLE' => PreviewProxyError(
        kind: PreviewProxyErrorKind.updateDesktop,
        statusCode: HttpStatus.serviceUnavailable,
        message: '请更新电脑上的 Pigcode 后使用本机预览。',
        code: code,
        requestUri: requestUri,
        isDocumentRequest: isDocumentRequest,
      ),
      _ => PreviewProxyError(
        kind: PreviewProxyErrorKind.unknown,
        statusCode: HttpStatus.badGateway,
        message: error.problem.message.trim().isNotEmpty
            ? error.problem.message
            : '预览加载失败，请稍后重试。',
        code: code,
        requestUri: requestUri,
        isDocumentRequest: isDocumentRequest,
      ),
    };
  }
  if (error is ConnectionFailure) {
    if (error.code == 'update-desktop') {
      return PreviewProxyError(
        kind: PreviewProxyErrorKind.updateDesktop,
        statusCode: HttpStatus.serviceUnavailable,
        message: '请更新电脑上的 Pigcode 后使用本机预览。',
        code: error.code,
        requestUri: requestUri,
        isDocumentRequest: isDocumentRequest,
      );
    }
    return PreviewProxyError(
      kind: PreviewProxyErrorKind.disconnected,
      statusCode: HttpStatus.serviceUnavailable,
      message: '电脑连接已断开，请重连后再试。',
      code: error.code,
      requestUri: requestUri,
      isDocumentRequest: isDocumentRequest,
    );
  }
  if (error is TimeoutException) {
    return PreviewProxyError(
      kind: PreviewProxyErrorKind.timeout,
      statusCode: HttpStatus.gatewayTimeout,
      message: '本机预览请求超时，请检查电脑上的服务是否正常响应。',
      code: 'PREVIEW_TIMEOUT',
      requestUri: requestUri,
      isDocumentRequest: isDocumentRequest,
    );
  }
  return PreviewProxyError(
    kind: PreviewProxyErrorKind.unknown,
    statusCode: HttpStatus.badGateway,
    message: '预览加载失败，请稍后重试。',
    requestUri: requestUri,
    isDocumentRequest: isDocumentRequest,
  );
}

/// 将 WebView 当前访问的本地代理地址 `http://127.0.0.1:<proxyPort>/path?query`
/// 还原为电脑端真实目标 URI（如 `http://localhost:5173/path?query`）。
Uri proxyUriToDisplayUri(Uri proxyUri, Uri targetOrigin) {
  final proxyHost = proxyUri.host.toLowerCase();
  if (proxyUri.scheme.toLowerCase() != 'http' ||
      (proxyHost != '127.0.0.1' && proxyHost != 'localhost')) {
    return proxyUri;
  }
  final authority = _formatUriAuthority(targetOrigin);
  final pathAndQuery = _extractRawPathAndQuery(proxyUri);
  final fragment = proxyUri.hasFragment ? '#${proxyUri.fragment}' : '';
  return Uri.parse('${targetOrigin.scheme}://$authority$pathAndQuery$fragment');
}

/// 改写 `Set-Cookie` 响应头，剥离 `; Secure`（不区分大小写）以及指向本机回环的显式 `Domain=` 属性，
/// 保证在 `http://127.0.0.1:<proxyPort>` 下本地开发服务的登录态 Cookie 正常工作。
String rewriteSetCookieForLocalProxy(String rawCookie) {
  final segments = rawCookie.split(';');
  if (segments.isEmpty) return rawCookie;
  final kept = <String>[segments.first.trim()];
  for (var i = 1; i < segments.length; i++) {
    final trimmed = segments[i].trim();
    if (trimmed.isEmpty) continue;
    final lower = trimmed.toLowerCase();
    if (lower == 'secure') {
      continue;
    }
    if (lower.startsWith('domain=')) {
      final rawDomain = lower.substring('domain='.length).trim();
      final normalizedDomain = rawDomain.startsWith('.')
          ? rawDomain.substring(1)
          : rawDomain;
      if (normalizedDomain == 'localhost' ||
          normalizedDomain == '127.0.0.1' ||
          normalizedDomain == '::1' ||
          normalizedDomain == '[::1]') {
        continue;
      }
    }
    kept.add(trimmed);
  }
  return kept.join('; ');
}

int _effectivePort(Uri uri) =>
    uri.hasPort ? uri.port : (uri.scheme.toLowerCase() == 'https' ? 443 : 80);

String _formatUriAuthority(Uri uri) {
  final host = uri.host.contains(':') ? '[${uri.host}]' : uri.host;
  return uri.hasPort ? '$host:${uri.port}' : host;
}

bool _isSameOrigin(Uri a, Uri b) =>
    a.scheme.toLowerCase() == b.scheme.toLowerCase() &&
    a.host.toLowerCase() == b.host.toLowerCase() &&
    _effectivePort(a) == _effectivePort(b);

bool _isHopByHopHeader(String lowerName, Set<String> connectionTokens) =>
    _hopByHopHeaders.contains(lowerName) ||
    lowerName.startsWith('proxy-') ||
    connectionTokens.contains(lowerName);

Set<String> _parseConnectionTokens(Iterable<String> values) {
  final tokens = <String>{};
  for (final raw in values) {
    for (final part in raw.split(',')) {
      final token = part.trim().toLowerCase();
      if (token.isNotEmpty) tokens.add(token);
    }
  }
  return tokens;
}

String _extractRawPathAndQuery(Uri uri) {
  if (uri.hasScheme || uri.hasAuthority) {
    final raw = uri.toString();
    final schemeEnd = raw.indexOf('://');
    final searchStart = schemeEnd >= 0 ? schemeEnd + 3 : 0;
    final slashIdx = raw.indexOf('/', searchStart);
    final queryIdx = raw.indexOf('?', searchStart);
    final hashIdx = raw.indexOf('#', searchStart);
    final end = hashIdx >= 0 ? hashIdx : raw.length;
    if (slashIdx >= 0 && slashIdx < end) {
      return raw.substring(slashIdx, end);
    }
    if (queryIdx >= 0 && queryIdx < end) {
      return '/${raw.substring(queryIdx, end)}';
    }
    return '/';
  }
  var raw = uri.toString();
  final hashIdx = raw.indexOf('#');
  if (hashIdx >= 0) raw = raw.substring(0, hashIdx);
  if (raw.isEmpty) return '/';
  if (raw.startsWith('/')) return raw;
  return '/$raw';
}

/// 纯 Dart 本地回环 HTTP 预览代理：
/// - 仅绑定 `127.0.0.1:0`（随机本机端口），将 WebView 发出的本地 HTTP 请求通过加密 RPC
///   `mobile.preview.fetch` / `streamBody` 转发到电脑端本机开发服务器；
/// - 重写同源 3xx `Location`、拦截跨源重定向并回调 `onExternalNavigation`；
/// - 清洗 `Set-Cookie`（剥离 `Secure` 与 `Domain=localhost`）并避免二次解压头冲突；
/// - 绑定连接生命周期，在 `close()` 或 `connection.done` 时立即释放端口并取消所有流。
class LocalPreviewProxy {
  LocalPreviewProxy({
    required this._previewCommands,
    this._connectionDone,
    this.onExternalNavigation,
    this.onProxyError,
  });

  factory LocalPreviewProxy.forConnection(
    MobileConnection connection, {
    void Function(Uri externalUrl)? onExternalNavigation,
    void Function(PreviewProxyError error)? onProxyError,
  }) => LocalPreviewProxy(
    previewCommands: connection.preview,
    connectionDone: connection.done,
    onExternalNavigation: onExternalNavigation,
    onProxyError: onProxyError,
  );

  final MobilePreviewCommands _previewCommands;
  final Future<void>? _connectionDone;
  final void Function(Uri externalUrl)? onExternalNavigation;
  final void Function(PreviewProxyError error)? onProxyError;

  HttpServer? _server;
  Uri? _targetOrigin;
  Uri? _proxyEntryUri;
  String _initialPath = '/';
  bool _closed = false;
  Future<void>? _closing;
  final Set<StreamSubscription<Uint8List>> _activeSubscriptions = {};
  final Set<String> _activeStreamIds = {};

  /// 代理绑定的随机本机回环端口；未启动或已关闭时为 `null`。
  int? get port => _server?.port;

  /// 目标本机服务 origin（仅含 scheme/host/port）。
  Uri? get targetOrigin => _targetOrigin;

  /// 代理入口地址（形如 `http://127.0.0.1:<proxyPort>/...`）。
  Uri? get proxyEntryUri => _proxyEntryUri;

  bool get isRunning => _server != null && !_closed;
  bool get isClosed => _closed;

  /// 判断给定 URI 是否属于当前活跃代理的回环源。
  bool isProxyOrigin(Uri uri) {
    final activePort = _server?.port;
    if (activePort == null || _closed) return false;
    final host = uri.host.toLowerCase();
    return uri.scheme.toLowerCase() == 'http' &&
        (host == '127.0.0.1' || host == 'localhost') &&
        uri.port == activePort;
  }

  /// 绑定 `127.0.0.1:0` 并开始监听请求，返回 WebView 应加载的代理入口 URI。
  Future<Uri> start(Uri targetUri) async {
    if (_closed) {
      throw StateError('LocalPreviewProxy has already been closed');
    }
    if (_server != null) {
      throw StateError('LocalPreviewProxy is already running');
    }

    final validated = normalizePreviewInput(targetUri.toString());
    final normalizedTarget = validated.uri;
    if (normalizedTarget == null) {
      throw ArgumentError.value(
        targetUri,
        'targetUri',
        validated.error ?? 'Invalid loopback preview URL',
      );
    }

    final origin = Uri(
      scheme: normalizedTarget.scheme,
      host: normalizedTarget.host,
      port: normalizedTarget.hasPort ? normalizedTarget.port : null,
    );

    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    if (_closed) {
      await server.close(force: true);
      throw StateError('LocalPreviewProxy was closed while starting');
    }

    _server = server;
    _targetOrigin = origin;
    _initialPath = normalizedTarget.path.isEmpty ? '/' : normalizedTarget.path;

    final pathAndQuery = _extractRawPathAndQuery(normalizedTarget);
    final fragment = normalizedTarget.hasFragment
        ? '#${normalizedTarget.fragment}'
        : '';
    _proxyEntryUri = Uri.parse(
      'http://127.0.0.1:${server.port}$pathAndQuery$fragment',
    );

    server.listen(
      (request) => unawaited(_handleRequest(request)),
      onError: (Object _) {},
      cancelOnError: false,
    );

    if (_connectionDone case final done?) {
      unawaited(done.whenComplete(() => unawaited(close())));
    }

    return _proxyEntryUri!;
  }

  /// 立即强制关闭本地代理端口，并取消所有正在进行的流式响应读取。
  Future<void> close() {
    if (_closing case final existing?) return existing;
    _closed = true;
    final future = _performClose();
    _closing = future;
    return future;
  }

  Future<void> _performClose() async {
    final subs = _activeSubscriptions.toList();
    _activeSubscriptions.clear();
    final streamIds = _activeStreamIds.toList();
    _activeStreamIds.clear();

    for (final sub in subs) {
      unawaited(sub.cancel().catchError((Object _) {}));
    }
    for (final streamId in streamIds) {
      unawaited(_previewCommands.closeBody(streamId).catchError((Object _) {}));
    }

    final server = _server;
    _server = null;
    if (server != null) {
      try {
        await server.close(force: true);
      } catch (_) {
        // Ignore close errors if already torn down.
      }
    }
  }

  Uri _mapRequestToTargetUri(Uri requestUri, Uri origin) {
    final authority = _formatUriAuthority(origin);
    final pathAndQuery = _extractRawPathAndQuery(requestUri);
    final mapped = Uri.parse('${origin.scheme}://$authority$pathAndQuery');
    if (!_isSameOrigin(mapped, origin)) {
      throw const MobileRpcFailure(
        MobileRpcProblem(
          code: 'PREVIEW_URL_NOT_ALLOWED',
          message: 'Blocked unexpected origin change',
        ),
      );
    }
    return mapped;
  }

  bool _isDocumentRequest(HttpRequest request, Uri targetUri) {
    final secFetchDest = request.headers.value('sec-fetch-dest')?.toLowerCase();
    if (secFetchDest == 'document') return true;
    if (secFetchDest != null && secFetchDest.isNotEmpty) return false;
    final accept = request.headers.value(HttpHeaders.acceptHeader) ?? '';
    if (accept.toLowerCase().contains('text/html')) return true;
    return request.method.toUpperCase() == 'GET' &&
        (targetUri.path == _initialPath || targetUri.path == '/');
  }

  Map<String, String> _collectForwardRequestHeaders(
    HttpHeaders incoming,
    Uri origin,
  ) {
    final connectionValues = incoming[HttpHeaders.connectionHeader] ?? const [];
    final extraHopByHop = _parseConnectionTokens(connectionValues);
    final result = <String, String>{};
    final originAuthority = _formatUriAuthority(origin);
    final targetOriginString = '${origin.scheme}://$originAuthority';
    final proxyPort = _server?.port;

    incoming.forEach((name, values) {
      if (result.length >= mobilePreviewMaxHeaders) return;
      final lower = name.toLowerCase();
      if (_isHopByHopHeader(lower, extraHopByHop) ||
          lower == 'host' ||
          lower == 'content-length' ||
          lower == 'accept-encoding') {
        return;
      }
      var joined = lower == 'cookie' ? values.join('; ') : values.join(', ');
      if (proxyPort != null && (lower == 'origin' || lower == 'referer')) {
        joined = _rewriteProxyOriginHeader(
          joined,
          proxyPort: proxyPort,
          targetOriginString: targetOriginString,
        );
      }
      if (name.length <= mobilePreviewHeaderNameMax &&
          joined.length <= mobilePreviewHeaderValueMax) {
        result[name] = joined;
      }
    });
    return result;
  }

  String _rewriteProxyOriginHeader(
    String value, {
    required int proxyPort,
    required String targetOriginString,
  }) {
    final parsed = Uri.tryParse(value.trim());
    if (parsed == null) return value;
    final host = parsed.host.toLowerCase();
    if (parsed.scheme.toLowerCase() == 'http' &&
        (host == '127.0.0.1' || host == 'localhost') &&
        parsed.port == proxyPort) {
      if (parsed.path.isEmpty && !parsed.hasQuery && !parsed.hasFragment) {
        return targetOriginString;
      }
      final pathAndQuery = _extractRawPathAndQuery(parsed);
      final fragment = parsed.hasFragment ? '#${parsed.fragment}' : '';
      return '$targetOriginString$pathAndQuery$fragment';
    }
    return value;
  }

  Future<({Uint8List? bytes, bool tooLarge})> _readRequestBody(
    HttpRequest request,
    String method,
  ) async {
    if (method == 'GET' || method == 'HEAD') {
      // Drain safely in case an unusual client sends 0-byte body chunks.
      var received = 0;
      await for (final chunk in request) {
        received += chunk.length;
        if (received > mobilePreviewMaxRequestBodyBytes) {
          return (bytes: null, tooLarge: true);
        }
      }
      return (bytes: null, tooLarge: false);
    }

    if (request.contentLength > mobilePreviewMaxRequestBodyBytes) {
      return (bytes: null, tooLarge: true);
    }

    final builder = BytesBuilder(copy: false);
    await for (final chunk in request) {
      if (builder.length + chunk.length > mobilePreviewMaxRequestBodyBytes) {
        return (bytes: null, tooLarge: true);
      }
      builder.add(chunk);
    }
    if (builder.isEmpty) {
      return (bytes: null, tooLarge: false);
    }
    return (bytes: builder.takeBytes(), tooLarge: false);
  }

  Future<void> _handleRequest(HttpRequest request) async {
    final origin = _targetOrigin;
    final response = request.response;
    if (_closed || origin == null) {
      await _writePlainError(
        response,
        HttpStatus.serviceUnavailable,
        '预览代理已关闭',
      );
      return;
    }

    final method = request.method.toUpperCase();
    if (!mobilePreviewAllowedMethods.contains(method)) {
      await _writePlainError(
        response,
        HttpStatus.methodNotAllowed,
        '不支持的 HTTP 方法：$method',
      );
      return;
    }

    Uri? targetUri;
    var isDoc = false;
    try {
      targetUri = _mapRequestToTargetUri(request.uri, origin);
      isDoc = _isDocumentRequest(request, targetUri);

      final bodyResult = await _readRequestBody(request, method);
      if (bodyResult.tooLarge) {
        await _writePlainError(
          response,
          HttpStatus.requestEntityTooLarge,
          '请求体超过 32 KiB 上限',
        );
        return;
      }

      if (_closed) {
        await _writePlainError(
          response,
          HttpStatus.serviceUnavailable,
          '预览代理已关闭',
        );
        return;
      }

      final forwardHeaders = _collectForwardRequestHeaders(
        request.headers,
        origin,
      );
      final fetched = await _previewCommands.fetch(
        url: targetUri.toString(),
        method: method,
        headers: forwardHeaders.isEmpty ? null : forwardHeaders,
        bodyBytes: bodyResult.bytes,
      );

      if (_closed) {
        if (fetched.hasMore && fetched.bodyStreamId != null) {
          unawaited(
            _previewCommands
                .closeBody(fetched.bodyStreamId!)
                .catchError((Object _) {}),
          );
        }
        await _writePlainError(
          response,
          HttpStatus.serviceUnavailable,
          '预览代理已关闭',
        );
        return;
      }

      await _writeFetchedResponse(
        response: response,
        method: method,
        targetUri: targetUri,
        origin: origin,
        fetched: fetched,
      );
    } catch (error) {
      final proxyError = previewErrorFromException(
        error,
        requestUri: targetUri,
        isDocumentRequest: isDoc,
      );
      onProxyError?.call(proxyError);
      await _writePlainError(
        response,
        proxyError.statusCode,
        proxyError.message,
      );
    }
  }

  Future<void> _writeFetchedResponse({
    required HttpResponse response,
    required String method,
    required Uri targetUri,
    required Uri origin,
    required MobilePreviewFetchResponse fetched,
  }) async {
    final activePort = _server?.port;
    String? rewrittenLocation;

    if (fetched.status >= 300 && fetched.status < 400) {
      final rawLocation = fetched.firstHeaderValue('location')?.trim();
      if (rawLocation != null && rawLocation.isNotEmpty) {
        Uri? resolved;
        try {
          resolved = targetUri.resolve(rawLocation);
        } on FormatException {
          resolved = null;
        }
        if (resolved != null) {
          if (_isSameOrigin(resolved, origin) && activePort != null) {
            final pathAndQuery = _extractRawPathAndQuery(resolved);
            final fragment = resolved.hasFragment
                ? '#${resolved.fragment}'
                : '';
            rewrittenLocation = 'http://127.0.0.1:$activePort$pathAndQuery$fragment';
          } else {
            // 跨端口或外部公网域名重定向：绝不静默跟进，立即关闭远端流并回调上层处理。
            if (fetched.hasMore && fetched.bodyStreamId != null) {
              unawaited(
                _previewCommands
                    .closeBody(fetched.bodyStreamId!)
                    .catchError((Object _) {}),
              );
            }
            onExternalNavigation?.call(resolved);
            response.statusCode = HttpStatus.noContent;
            response.headers.set(HttpHeaders.cacheControlHeader, 'no-store');
            await response.close();
            return;
          }
        }
      }
    }

    final connectionValues = fetched.headerValues('connection');
    final extraHopByHop = _parseConnectionTokens(connectionValues);

    response.statusCode = fetched.status;
    if (fetched.statusText.isNotEmpty) {
      response.reasonPhrase = fetched.statusText;
    }

    for (final header in fetched.headers) {
      final lower = header.name.toLowerCase();
      if (lower == 'content-encoding' ||
          lower == 'transfer-encoding' ||
          lower == 'content-length' ||
          _isHopByHopHeader(lower, extraHopByHop)) {
        continue;
      }
      if (lower == 'location') {
        if (rewrittenLocation != null) {
          response.headers.set(HttpHeaders.locationHeader, rewrittenLocation);
        }
        continue;
      }
      if (lower == 'set-cookie') {
        response.headers.add(
          HttpHeaders.setCookieHeader,
          rewriteSetCookieForLocalProxy(header.value),
          preserveHeaderCase: false,
        );
        continue;
      }
      response.headers.add(header.name, header.value);
    }

    final noBodyStatus =
        method == 'HEAD' ||
        fetched.status == HttpStatus.noContent ||
        fetched.status == HttpStatus.notModified ||
        (fetched.status >= 100 && fetched.status < 200);

    if (noBodyStatus) {
      if (fetched.hasMore && fetched.bodyStreamId != null) {
        unawaited(
          _previewCommands
              .closeBody(fetched.bodyStreamId!)
              .catchError((Object _) {}),
        );
      }
      await response.close();
      return;
    }

    if (!fetched.hasMore) {
      final inlineBytes = fetched.inlineBodyBytes ?? Uint8List(0);
      response.contentLength = inlineBytes.length;
      if (inlineBytes.isNotEmpty) {
        response.add(inlineBytes);
      }
      await response.close();
      return;
    }

    final streamId = fetched.bodyStreamId;
    if (streamId == null) {
      await response.close();
      return;
    }

    await _pipeResponseStream(
      response: response,
      streamId: streamId,
      targetUri: targetUri,
    );
  }

  Future<void> _pipeResponseStream({
    required HttpResponse response,
    required String streamId,
    required Uri targetUri,
  }) async {
    _activeStreamIds.add(streamId);
    final stream = _previewCommands.streamBody(streamId);
    final completer = Completer<void>();
    var clientClosed = false;
    late final StreamSubscription<Uint8List> subscription;

    unawaited(
      response.done.then<void>(
        (_) {},
        onError: (Object _) {
          clientClosed = true;
          if (!completer.isCompleted) {
            unawaited(subscription.cancel().catchError((Object _) {}));
            completer.complete();
          }
        },
      ),
    );

    subscription = stream.listen(
      (chunk) {
        if (_closed || clientClosed) {
          unawaited(subscription.cancel().catchError((Object _) {}));
          if (!completer.isCompleted) completer.complete();
          return;
        }
        subscription.pause();
        try {
          response.add(chunk);
        } catch (_) {
          clientClosed = true;
          unawaited(subscription.cancel().catchError((Object _) {}));
          if (!completer.isCompleted) completer.complete();
          return;
        }
        unawaited(
          response.flush().then<void>(
            (_) {
              if (!_closed && !clientClosed && !completer.isCompleted) {
                subscription.resume();
              }
            },
            onError: (Object _) {
              clientClosed = true;
              unawaited(subscription.cancel().catchError((Object _) {}));
              if (!completer.isCompleted) completer.complete();
            },
          ),
        );
      },
      onError: (Object error, StackTrace stack) {
        if (!completer.isCompleted) completer.completeError(error, stack);
      },
      onDone: () {
        if (!completer.isCompleted) completer.complete();
      },
      cancelOnError: true,
    );

    _activeSubscriptions.add(subscription);
    try {
      await completer.future;
    } catch (error) {
      final proxyError = previewErrorFromException(
        error,
        requestUri: targetUri,
        isDocumentRequest: false,
      );
      onProxyError?.call(proxyError);
    } finally {
      _activeSubscriptions.remove(subscription);
      _activeStreamIds.remove(streamId);
      await subscription.cancel().catchError((Object _) {});
    }

    if (!clientClosed) {
      try {
        await response.close();
      } catch (_) {
        // Ignore socket write errors if client already disconnected.
      }
    }
  }

  Future<void> _writePlainError(
    HttpResponse response,
    int statusCode,
    String message,
  ) async {
    try {
      final bytes = utf8.encode(message);
      response.statusCode = statusCode;
      response.headers.contentType = ContentType.text;
      response.headers.set(HttpHeaders.cacheControlHeader, 'no-store');
      response.contentLength = bytes.length;
      response.add(bytes);
      await response.close();
    } catch (_) {
      // Headers may already have been sent or client socket may already be closed.
      try {
        await response.close();
      } catch (_) {}
    }
  }
}
