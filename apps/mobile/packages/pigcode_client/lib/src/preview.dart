import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:pigcode_transport/pigcode_transport.dart';

import '../host_rpc.dart';

const mobilePreviewInlineBodyMax = 24 * 1024;
const mobilePreviewChunkBytes = 32 * 1024;
const mobilePreviewMaxRequestBodyBytes = 32 * 1024;
const mobilePreviewMaxResponseBodyBytes = 16 * 1024 * 1024;
const mobilePreviewMaxHeaders = 64;
const mobilePreviewUrlMax = 4096;
const mobilePreviewRequestIdMax = 128;
const mobilePreviewStreamIdMax = 128;
const mobilePreviewHeaderNameMax = 256;
const mobilePreviewHeaderValueMax = 8192;
const mobilePreviewMaxDesktopUrls = 64;
const _maxSafeInt = 9007199254740991;

const mobilePreviewAllowedMethods = <String>{
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
};

abstract final class MobilePreviewMethods {
  static const status = 'mobile.preview.status';
  static const fetch = 'mobile.preview.fetch';
  static const readBody = 'mobile.preview.readBody';
  static const closeBody = 'mobile.preview.closeBody';
}

bool _listEquals<T>(List<T> a, List<T> b) {
  if (identical(a, b)) return true;
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

final class MobilePreviewStatus {
  const MobilePreviewStatus({
    required this.enabled,
    required this.desktopUrls,
  });

  final bool enabled;
  final List<String> desktopUrls;

  factory MobilePreviewStatus.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'enabled', 'desktopUrls'}.contains(key))) {
      throw const FormatException('MobilePreviewStatus contains an unknown field');
    }
    final enabled = json['enabled'] as bool;
    final rawUrls = json['desktopUrls'] as List<dynamic>;
    if (rawUrls.length > mobilePreviewMaxDesktopUrls) {
      throw const FormatException('Too many desktopUrls');
    }
    final urls = List<String>.unmodifiable(
      rawUrls.map((item) {
        final url = item as String;
        if (url.isEmpty || url.length > mobilePreviewUrlMax) {
          throw const FormatException('Invalid desktop preview url');
        }
        return url;
      }),
    );
    return MobilePreviewStatus(enabled: enabled, desktopUrls: urls);
  }

  Map<String, Object?> toJson() => {
    'enabled': enabled,
    'desktopUrls': desktopUrls,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobilePreviewStatus &&
          enabled == other.enabled &&
          _listEquals(desktopUrls, other.desktopUrls);

  @override
  int get hashCode => Object.hash(enabled, Object.hashAll(desktopUrls));
}

final class MobilePreviewHeader {
  const MobilePreviewHeader({required this.name, required this.value});

  final String name;
  final String value;

  factory MobilePreviewHeader.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'name', 'value'}.contains(key))) {
      throw const FormatException('MobilePreviewHeader contains an unknown field');
    }
    final name = json['name'] as String;
    if (name.isEmpty || name.length > mobilePreviewHeaderNameMax) {
      throw const FormatException('Invalid header name');
    }
    final value = json['value'] as String;
    if (value.length > mobilePreviewHeaderValueMax) {
      throw const FormatException('Invalid header value');
    }
    return MobilePreviewHeader(name: name, value: value);
  }

  Map<String, Object?> toJson() => {'name': name, 'value': value};

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobilePreviewHeader &&
          name == other.name &&
          value == other.value;

  @override
  int get hashCode => Object.hash(name, value);
}

final class MobilePreviewFetchResponse {
  const MobilePreviewFetchResponse({
    required this.status,
    required this.statusText,
    required this.headers,
    this.bodyBase64,
    this.bodyStreamId,
    required this.totalBytes,
    required this.hasMore,
  });

  final int status;
  final String statusText;
  final List<MobilePreviewHeader> headers;
  final String? bodyBase64;
  final String? bodyStreamId;
  final int totalBytes;
  final bool hasMore;

  Uint8List? get inlineBodyBytes =>
      bodyBase64 == null ? null : base64Decode(bodyBase64!);

  List<String> headerValues(String name) {
    final target = name.toLowerCase();
    return [
      for (final header in headers)
        if (header.name.toLowerCase() == target) header.value,
    ];
  }

  String? firstHeaderValue(String name) {
    final target = name.toLowerCase();
    for (final header in headers) {
      if (header.name.toLowerCase() == target) return header.value;
    }
    return null;
  }

  factory MobilePreviewFetchResponse.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'status',
        'statusText',
        'headers',
        'bodyBase64',
        'bodyStreamId',
        'totalBytes',
        'hasMore',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobilePreviewFetchResponse contains an unknown field',
      );
    }
    final status = json['status'] as int;
    if (status < 100 || status > 599) {
      throw const FormatException('Invalid HTTP status');
    }
    final statusText = json['statusText'] as String;
    if (statusText.length > 256) {
      throw const FormatException('Invalid statusText');
    }
    final headers = List<MobilePreviewHeader>.unmodifiable(
      (json['headers'] as List<dynamic>).map(
        (item) => MobilePreviewHeader.fromJson(item as Map<String, dynamic>),
      ),
    );
    final bodyBase64 = json.containsKey('bodyBase64')
        ? json['bodyBase64'] as String
        : null;
    final bodyStreamId = json.containsKey('bodyStreamId')
        ? json['bodyStreamId'] as String
        : null;
    if (bodyStreamId != null &&
        (bodyStreamId.isEmpty || bodyStreamId.length > mobilePreviewStreamIdMax)) {
      throw const FormatException('Invalid bodyStreamId');
    }
    final totalBytes = json['totalBytes'] as int;
    if (totalBytes < 0 || totalBytes > _maxSafeInt) {
      throw const FormatException('Invalid totalBytes');
    }
    final hasMore = json['hasMore'] as bool;
    if (hasMore && bodyStreamId == null) {
      throw const FormatException('Missing bodyStreamId when hasMore is true');
    }
    return MobilePreviewFetchResponse(
      status: status,
      statusText: statusText,
      headers: headers,
      bodyBase64: bodyBase64,
      bodyStreamId: bodyStreamId,
      totalBytes: totalBytes,
      hasMore: hasMore,
    );
  }

  Map<String, Object?> toJson() => {
    'status': status,
    'statusText': statusText,
    'headers': headers.map((header) => header.toJson()).toList(),
    'bodyBase64': ?bodyBase64,
    'bodyStreamId': ?bodyStreamId,
    'totalBytes': totalBytes,
    'hasMore': hasMore,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobilePreviewFetchResponse &&
          status == other.status &&
          statusText == other.statusText &&
          _listEquals(headers, other.headers) &&
          bodyBase64 == other.bodyBase64 &&
          bodyStreamId == other.bodyStreamId &&
          totalBytes == other.totalBytes &&
          hasMore == other.hasMore;

  @override
  int get hashCode => Object.hash(
    status,
    statusText,
    Object.hashAll(headers),
    bodyBase64,
    bodyStreamId,
    totalBytes,
    hasMore,
  );
}

final class MobilePreviewBodyChunk {
  const MobilePreviewBodyChunk({
    required this.bodyStreamId,
    required this.dataBase64,
    required this.totalBytes,
    this.nextOffset,
  });

  final String bodyStreamId;
  final String dataBase64;
  final int totalBytes;
  final int? nextOffset;

  Uint8List get bytes => base64Decode(dataBase64);

  factory MobilePreviewBodyChunk.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'bodyStreamId',
        'dataBase64',
        'totalBytes',
        'nextOffset',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobilePreviewBodyChunk contains an unknown field',
      );
    }
    final bodyStreamId = json['bodyStreamId'] as String;
    if (bodyStreamId.isEmpty || bodyStreamId.length > mobilePreviewStreamIdMax) {
      throw const FormatException('Invalid bodyStreamId');
    }
    final dataBase64 = json['dataBase64'] as String;
    final totalBytes = json['totalBytes'] as int;
    if (totalBytes < 0 || totalBytes > _maxSafeInt) {
      throw const FormatException('Invalid totalBytes');
    }
    final nextOffset = json.containsKey('nextOffset')
        ? json['nextOffset'] as int
        : null;
    if (nextOffset != null && (nextOffset < 0 || nextOffset > _maxSafeInt)) {
      throw const FormatException('Invalid nextOffset');
    }
    return MobilePreviewBodyChunk(
      bodyStreamId: bodyStreamId,
      dataBase64: dataBase64,
      totalBytes: totalBytes,
      nextOffset: nextOffset,
    );
  }

  Map<String, Object?> toJson() => {
    'bodyStreamId': bodyStreamId,
    'dataBase64': dataBase64,
    'totalBytes': totalBytes,
    'nextOffset': ?nextOffset,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobilePreviewBodyChunk &&
          bodyStreamId == other.bodyStreamId &&
          dataBase64 == other.dataBase64 &&
          totalBytes == other.totalBytes &&
          nextOffset == other.nextOffset;

  @override
  int get hashCode =>
      Object.hash(bodyStreamId, dataBase64, totalBytes, nextOffset);
}

final class MobilePreviewCommands {
  MobilePreviewCommands(this._rpc, {this.supportsPreviewTunnel = true});

  final HostRequests _rpc;
  final bool supportsPreviewTunnel;
  var _requestSeq = 0;

  void _requireSupport() {
    if (!supportsPreviewTunnel) {
      throw const ConnectionFailure('update-desktop');
    }
  }

  String _nextRequestId() =>
      'preview-${DateTime.now().microsecondsSinceEpoch}-${++_requestSeq}';

  Future<MobilePreviewStatus> getStatus({String? threadId}) async {
    _requireSupport();
    if (threadId != null && threadId.isEmpty) {
      throw ArgumentError.value(threadId, 'threadId', 'must not be empty');
    }
    final result = await _rpc.call(MobilePreviewMethods.status, {
      'threadId': ?threadId,
    });
    if (result is! Map<String, dynamic>) {
      throw const FormatException('Invalid mobile.preview.status result');
    }
    return MobilePreviewStatus.fromJson(result);
  }

  Future<MobilePreviewFetchResponse> fetch({
    required String url,
    String method = 'GET',
    Map<String, String>? headers,
    Uint8List? bodyBytes,
    String? requestId,
  }) async {
    _requireSupport();
    if (url.isEmpty || url.length > mobilePreviewUrlMax) {
      throw ArgumentError.value(url, 'url', 'must be 1..4096 characters');
    }
    final normalizedMethod = method.toUpperCase();
    if (!mobilePreviewAllowedMethods.contains(normalizedMethod)) {
      throw ArgumentError.value(method, 'method', 'unsupported HTTP method');
    }
    if (headers != null && headers.length > mobilePreviewMaxHeaders) {
      throw RangeError.range(
        headers.length,
        0,
        mobilePreviewMaxHeaders,
        'headers',
      );
    }
    if (bodyBytes != null) {
      if (bodyBytes.length > mobilePreviewMaxRequestBodyBytes) {
        throw RangeError.range(
          bodyBytes.length,
          0,
          mobilePreviewMaxRequestBodyBytes,
          'bodyBytes',
        );
      }
      if ((normalizedMethod == 'GET' || normalizedMethod == 'HEAD') &&
          bodyBytes.isNotEmpty) {
        throw ArgumentError.value(
          bodyBytes,
          'bodyBytes',
          'GET and HEAD requests must not include a body',
        );
      }
    }
    final resolvedRequestId = requestId ?? _nextRequestId();
    if (resolvedRequestId.isEmpty ||
        resolvedRequestId.length > mobilePreviewRequestIdMax) {
      throw ArgumentError.value(
        requestId,
        'requestId',
        'must be 1..128 characters',
      );
    }

    final result = await _rpc.call(MobilePreviewMethods.fetch, {
      'requestId': resolvedRequestId,
      'url': url,
      'method': normalizedMethod,
      if (headers != null) 'headers': Map<String, String>.from(headers),
      if (bodyBytes != null) 'bodyBase64': base64Encode(bodyBytes),
    });
    if (result is! Map<String, dynamic>) {
      throw const FormatException('Invalid mobile.preview.fetch result');
    }
    return MobilePreviewFetchResponse.fromJson(result);
  }

  Future<MobilePreviewBodyChunk> readBody({
    required String bodyStreamId,
    required int offset,
    int? length,
  }) async {
    _requireSupport();
    if (bodyStreamId.isEmpty ||
        bodyStreamId.length > mobilePreviewStreamIdMax) {
      throw ArgumentError.value(
        bodyStreamId,
        'bodyStreamId',
        'must be 1..128 characters',
      );
    }
    if (offset < 0) {
      throw RangeError.range(offset, 0, null, 'offset');
    }
    if (length != null && (length < 1 || length > mobilePreviewChunkBytes)) {
      throw RangeError.range(length, 1, mobilePreviewChunkBytes, 'length');
    }

    final result = await _rpc.call(MobilePreviewMethods.readBody, {
      'bodyStreamId': bodyStreamId,
      'offset': offset,
      'length': ?length,
    });
    if (result is! Map<String, dynamic>) {
      throw const FormatException('Invalid mobile.preview.readBody result');
    }
    return MobilePreviewBodyChunk.fromJson(result);
  }

  Future<void> closeBody(String bodyStreamId) async {
    _requireSupport();
    if (bodyStreamId.isEmpty ||
        bodyStreamId.length > mobilePreviewStreamIdMax) {
      throw ArgumentError.value(
        bodyStreamId,
        'bodyStreamId',
        'must be 1..128 characters',
      );
    }

    final result = await _rpc.call(MobilePreviewMethods.closeBody, {
      'bodyStreamId': bodyStreamId,
    });
    if (result is! Map<String, dynamic> || result['ok'] != true) {
      throw const FormatException('Invalid mobile.preview.closeBody result');
    }
  }

  Stream<Uint8List> streamBody(
    String bodyStreamId, {
    int chunkBytes = mobilePreviewChunkBytes,
  }) {
    _requireSupport();
    if (bodyStreamId.isEmpty ||
        bodyStreamId.length > mobilePreviewStreamIdMax) {
      throw ArgumentError.value(
        bodyStreamId,
        'bodyStreamId',
        'must be 1..128 characters',
      );
    }
    if (chunkBytes < 1 || chunkBytes > mobilePreviewChunkBytes) {
      throw RangeError.range(
        chunkBytes,
        1,
        mobilePreviewChunkBytes,
        'chunkBytes',
      );
    }
    return _streamBody(bodyStreamId, chunkBytes);
  }

  Stream<Uint8List> _streamBody(String bodyStreamId, int chunkBytes) async* {
    var offset = 0;
    int? expectedTotal;
    try {
      while (true) {
        final chunk = await readBody(
          bodyStreamId: bodyStreamId,
          offset: offset,
          length: chunkBytes,
        );
        if (chunk.bodyStreamId != bodyStreamId) {
          throw const FormatException('Preview bodyStreamId mismatch');
        }
        expectedTotal ??= chunk.totalBytes;
        if (chunk.totalBytes != expectedTotal) {
          throw const FormatException('Preview stream totalBytes changed');
        }
        final bytes = chunk.bytes;
        if (offset + bytes.length > expectedTotal) {
          throw const FormatException('Preview chunk exceeds totalBytes');
        }
        final next = chunk.nextOffset;
        if (next != null) {
          if (next <= offset ||
              next != offset + bytes.length ||
              next > expectedTotal) {
            throw const FormatException('Invalid preview chunk nextOffset');
          }
        } else if (offset + bytes.length != expectedTotal) {
          throw const FormatException('Incomplete preview stream before EOF');
        }
        if (bytes.isNotEmpty) {
          yield bytes;
        }
        if (next == null) break;
        offset = next;
      }
    } finally {
      try {
        await closeBody(bodyStreamId);
      } catch (_) {
        // Ignore cleanup errors when closing or cancelling a preview body stream.
      }
    }
  }
}
