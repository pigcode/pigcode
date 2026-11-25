import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:pigcode_transport/pigcode_transport.dart';

import '../host_rpc.dart';

const mobileMaxImageBytes = 4 * 1024 * 1024;
const mobileAttachmentChunkBytes = 32 * 1024;
const mobileMaxMessageAttachments = 6;
const mobileAttachmentUploadConcurrency = 4;

const mobileAttachmentMimeTypes = <String>{
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
};

abstract final class MobileAttachmentMethods {
  static const uploadStart = 'mobile.attachment.uploadStart';
  static const uploadChunk = 'mobile.attachment.uploadChunk';
  static const uploadCancel = 'mobile.attachment.uploadCancel';
  static const uploadFinish = 'mobile.attachment.uploadFinish';
  static const read = 'mobile.attachment.read';
}

typedef MobileAttachmentReadData = ({
  MobileAttachmentRef attachment,
  String mimeType,
  Uint8List bytes,
});

final class MobileAttachmentRef {
  const MobileAttachmentRef({
    required this.id,
    required this.mimeType,
    required this.fileName,
    required this.sizeBytes,
    this.width,
    this.height,
  });

  final String id;
  final String mimeType;
  final String fileName;
  final int sizeBytes;
  final int? width;
  final int? height;

  factory MobileAttachmentRef.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'id',
        'mimeType',
        'fileName',
        'sizeBytes',
        'width',
        'height',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileAttachmentRef contains an unknown field',
      );
    }
    final id = json['id'] as String;
    if (id.isEmpty || id.length > 128) {
      throw const FormatException('Invalid id');
    }
    final mimeType = json['mimeType'] as String;
    if (!mobileAttachmentMimeTypes.contains(mimeType)) {
      throw const FormatException('Invalid mimeType');
    }
    final fileName = json['fileName'] as String;
    if (fileName.isEmpty || fileName.length > 255) {
      throw const FormatException('Invalid fileName');
    }
    final sizeBytes = json['sizeBytes'] as int;
    if (sizeBytes <= 0 || sizeBytes > 9007199254740991) {
      throw const FormatException('Invalid sizeBytes');
    }
    final width = json.containsKey('width') ? json['width'] as int : null;
    if (width != null && (width <= 0 || width > 9007199254740991)) {
      throw const FormatException('Invalid width');
    }
    final height = json.containsKey('height') ? json['height'] as int : null;
    if (height != null && (height <= 0 || height > 9007199254740991)) {
      throw const FormatException('Invalid height');
    }
    return MobileAttachmentRef(
      id: id,
      mimeType: mimeType,
      fileName: fileName,
      sizeBytes: sizeBytes,
      width: width,
      height: height,
    );
  }

  Map<String, Object?> toJson() => {
    'id': id,
    'mimeType': mimeType,
    'fileName': fileName,
    'sizeBytes': sizeBytes,
    'width': ?width,
    'height': ?height,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobileAttachmentRef &&
          id == other.id &&
          mimeType == other.mimeType &&
          fileName == other.fileName &&
          sizeBytes == other.sizeBytes &&
          width == other.width &&
          height == other.height;

  @override
  int get hashCode =>
      Object.hash(id, mimeType, fileName, sizeBytes, width, height);
}

final class MobileAttachmentUploadProgress {
  const MobileAttachmentUploadProgress({
    required this.uploadedBytes,
    required this.totalBytes,
  });

  final int uploadedBytes;
  final int totalBytes;

  double get fraction => totalBytes <= 0 ? 0 : uploadedBytes / totalBytes;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobileAttachmentUploadProgress &&
          uploadedBytes == other.uploadedBytes &&
          totalBytes == other.totalBytes;

  @override
  int get hashCode => Object.hash(uploadedBytes, totalBytes);
}

final class MobileAttachmentUploadCancelled implements Exception {
  const MobileAttachmentUploadCancelled();

  @override
  String toString() => 'MobileAttachmentUploadCancelled';
}

final class MobileAttachmentCancelToken {
  bool _cancelled = false;
  final _listeners = <void Function()>[];

  bool get isCancelled => _cancelled;

  void cancel() {
    if (_cancelled) return;
    _cancelled = true;
    final callbacks = List<void Function()>.of(_listeners);
    _listeners.clear();
    for (final callback in callbacks) {
      callback();
    }
  }

  void Function() _addListener(void Function() listener) {
    if (_cancelled) {
      listener();
      return () {};
    }
    _listeners.add(listener);
    return () => _listeners.remove(listener);
  }
}

final class MobileAttachmentUploadStartResult {
  const MobileAttachmentUploadStartResult({
    required this.uploadId,
    required this.chunkBytes,
  });

  final String uploadId;
  final int chunkBytes;

  factory MobileAttachmentUploadStartResult.fromJson(
    Map<String, dynamic> json,
  ) {
    if (json.keys.any(
      (key) => !const {'uploadId', 'chunkBytes'}.contains(key),
    )) {
      throw const FormatException(
        'MobileAttachmentUploadStartResult contains an unknown field',
      );
    }
    final uploadId = json['uploadId'] as String;
    if (uploadId.isEmpty || uploadId.length > 128) {
      throw const FormatException('Invalid uploadId');
    }
    final chunkBytes = json['chunkBytes'] as int;
    if (chunkBytes <= 0 || chunkBytes > mobileAttachmentChunkBytes) {
      throw const FormatException('Invalid chunkBytes');
    }
    return MobileAttachmentUploadStartResult(
      uploadId: uploadId,
      chunkBytes: chunkBytes,
    );
  }
}

final class MobileAttachmentUploadChunkResult {
  const MobileAttachmentUploadChunkResult({
    required this.uploadId,
    required this.receivedBytes,
  });

  final String uploadId;
  final int receivedBytes;

  factory MobileAttachmentUploadChunkResult.fromJson(
    Map<String, dynamic> json,
  ) {
    if (json.keys.any(
      (key) => !const {'uploadId', 'receivedBytes'}.contains(key),
    )) {
      throw const FormatException(
        'MobileAttachmentUploadChunkResult contains an unknown field',
      );
    }
    final uploadId = json['uploadId'] as String;
    if (uploadId.isEmpty || uploadId.length > 128) {
      throw const FormatException('Invalid uploadId');
    }
    final receivedBytes = json['receivedBytes'] as int;
    if (receivedBytes < 0 || receivedBytes > mobileMaxImageBytes) {
      throw const FormatException('Invalid receivedBytes');
    }
    return MobileAttachmentUploadChunkResult(
      uploadId: uploadId,
      receivedBytes: receivedBytes,
    );
  }
}

final class MobileAttachmentUploadFinishResult {
  const MobileAttachmentUploadFinishResult({required this.attachment});

  final MobileAttachmentRef attachment;

  factory MobileAttachmentUploadFinishResult.fromJson(
    Map<String, dynamic> json,
  ) {
    if (json.keys.any((key) => !const {'attachment'}.contains(key))) {
      throw const FormatException(
        'MobileAttachmentUploadFinishResult contains an unknown field',
      );
    }
    return MobileAttachmentUploadFinishResult(
      attachment: MobileAttachmentRef.fromJson(
        json['attachment'] as Map<String, dynamic>,
      ),
    );
  }
}

final class MobileAttachmentReadResult {
  const MobileAttachmentReadResult({
    required this.attachment,
    required this.mimeType,
    required this.dataBase64,
    required this.totalBytes,
    this.nextOffset,
  });

  final MobileAttachmentRef attachment;
  final String mimeType;
  final String dataBase64;
  final int totalBytes;
  final int? nextOffset;

  factory MobileAttachmentReadResult.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'attachment',
        'mimeType',
        'dataBase64',
        'totalBytes',
        'nextOffset',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileAttachmentReadResult contains an unknown field',
      );
    }
    final attachment = MobileAttachmentRef.fromJson(
      json['attachment'] as Map<String, dynamic>,
    );
    final mimeType = json['mimeType'] as String;
    if (!mobileAttachmentMimeTypes.contains(mimeType)) {
      throw const FormatException('Invalid mimeType');
    }
    final dataBase64 = json['dataBase64'] as String;
    final totalBytes = json['totalBytes'] as int;
    if (totalBytes < 0 || totalBytes > 9007199254740991) {
      throw const FormatException('Invalid totalBytes');
    }
    final nextOffset = json.containsKey('nextOffset')
        ? json['nextOffset'] as int
        : null;
    if (nextOffset != null &&
        (nextOffset <= 0 || nextOffset > 9007199254740991)) {
      throw const FormatException('Invalid nextOffset');
    }
    return MobileAttachmentReadResult(
      attachment: attachment,
      mimeType: mimeType,
      dataBase64: dataBase64,
      totalBytes: totalBytes,
      nextOffset: nextOffset,
    );
  }
}

List<MobileAttachmentRef> parseMobileAttachmentRefs(Object? raw) {
  if (raw == null) return const [];
  final list = raw as List<dynamic>;
  if (list.length > mobileMaxMessageAttachments) {
    throw const FormatException('Too many attachments');
  }
  return List<MobileAttachmentRef>.unmodifiable(
    list.map(
      (item) => MobileAttachmentRef.fromJson(item as Map<String, dynamic>),
    ),
  );
}

List<String>? parseMobileAttachmentIds(Object? raw) {
  if (raw == null) return null;
  final list = raw as List<dynamic>;
  if (list.length > mobileMaxMessageAttachments) {
    throw const FormatException('Too many attachmentIds');
  }
  return List<String>.unmodifiable(
    list.map((item) {
      final id = item as String;
      if (id.isEmpty || id.length > 128) {
        throw const FormatException('Invalid attachmentId');
      }
      return id;
    }),
  );
}

final _secureRandom = Random.secure();

String _defaultUploadId() {
  final bytes = Uint8List(16);
  for (var i = 0; i < bytes.length; i++) {
    bytes[i] = _secureRandom.nextInt(256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  String hex(int start, int end) => bytes
      .sublist(start, end)
      .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();
  return '${hex(0, 4)}-${hex(4, 6)}-${hex(6, 8)}-${hex(8, 10)}-${hex(10, 16)}';
}

class MobileAttachmentCommands {
  MobileAttachmentCommands(
    this._rpc, {
    this.supportsAttachments = true,
    String Function()? generateUploadId,
  }) : _generateUploadId = generateUploadId ?? _defaultUploadId;

  final HostRequests _rpc;
  final bool supportsAttachments;
  final String Function() _generateUploadId;

  Future<MobileAttachmentRef> uploadAttachment({
    required Uint8List bytes,
    required String mimeType,
    String? fileName,
    int? width,
    int? height,
    void Function(MobileAttachmentUploadProgress)? onProgress,
    MobileAttachmentCancelToken? cancelToken,
  }) async {
    if (!supportsAttachments) {
      throw const ConnectionFailure('update-desktop');
    }
    if (bytes.isEmpty || bytes.length > mobileMaxImageBytes) {
      throw RangeError.range(bytes.length, 1, mobileMaxImageBytes, 'bytes');
    }
    if (!mobileAttachmentMimeTypes.contains(mimeType)) {
      throw ArgumentError.value(
        mimeType,
        'mimeType',
        'Unsupported image mime type',
      );
    }
    if (fileName != null && (fileName.isEmpty || fileName.length > 255)) {
      throw ArgumentError.value(fileName, 'fileName', 'Invalid fileName');
    }
    if (width != null && width <= 0) {
      throw ArgumentError.value(width, 'width', 'Must be positive');
    }
    if (height != null && height <= 0) {
      throw ArgumentError.value(height, 'height', 'Must be positive');
    }
    if (cancelToken?.isCancelled ?? false) {
      throw const MobileAttachmentUploadCancelled();
    }

    final sha256Hex = await publicKeyFingerprint(bytes);
    if (cancelToken?.isCancelled ?? false) {
      throw const MobileAttachmentUploadCancelled();
    }

    final uploadId = _generateUploadId();
    final startRaw = await _rpc.call(MobileAttachmentMethods.uploadStart, {
      'uploadId': uploadId,
      'mimeType': mimeType,
      'fileName': ?fileName,
      'totalBytes': bytes.length,
      'sha256': sha256Hex,
      'width': ?width,
      'height': ?height,
    });
    final start = MobileAttachmentUploadStartResult.fromJson(
      startRaw as Map<String, dynamic>,
    );
    if (start.uploadId != uploadId) {
      throw const FormatException('Unexpected uploadId');
    }

    var cancelSent = false;
    Future<void>? cancelFlight;
    Future<void> sendCancelOnce() {
      if (cancelSent) return cancelFlight ?? Future<void>.value();
      cancelSent = true;
      cancelFlight = _rpc
          .call(MobileAttachmentMethods.uploadCancel, {'uploadId': uploadId})
          .then<void>((_) {}, onError: (Object _) {});
      return cancelFlight!;
    }

    if (cancelToken?.isCancelled ?? false) {
      await sendCancelOnce();
      throw const MobileAttachmentUploadCancelled();
    }

    final chunkBytes = min(start.chunkBytes, mobileAttachmentChunkBytes);
    final chunks = <({int offset, int length})>[];
    for (var offset = 0; offset < bytes.length; offset += chunkBytes) {
      chunks.add((
        offset: offset,
        length: min(chunkBytes, bytes.length - offset),
      ));
    }

    var nextIndex = 0;
    var uploadedBytes = 0;
    var cancelled = false;
    Object? failure;
    StackTrace? failureStack;
    final abortCompleter = Completer<void>();

    void signalAbort() {
      if (!abortCompleter.isCompleted) abortCompleter.complete();
    }

    final removeCancelListener = cancelToken?._addListener(() {
      cancelled = true;
      signalAbort();
    });

    Future<void> worker() async {
      while (true) {
        if (cancelled ||
            failure != null ||
            (cancelToken?.isCancelled ?? false)) {
          return;
        }
        if (nextIndex >= chunks.length) return;
        final chunk = chunks[nextIndex++];
        final slice = Uint8List.sublistView(
          bytes,
          chunk.offset,
          chunk.offset + chunk.length,
        );
        try {
          final chunkRaw = await _rpc.call(
            MobileAttachmentMethods.uploadChunk,
            {
              'uploadId': uploadId,
              'offset': chunk.offset,
              'dataBase64': base64Encode(slice),
            },
          );
          final result = MobileAttachmentUploadChunkResult.fromJson(
            chunkRaw as Map<String, dynamic>,
          );
          if (result.uploadId != uploadId) {
            throw const FormatException('Unexpected chunk uploadId');
          }
          if (cancelled ||
              failure != null ||
              (cancelToken?.isCancelled ?? false)) {
            return;
          }
          uploadedBytes += chunk.length;
          onProgress?.call(
            MobileAttachmentUploadProgress(
              uploadedBytes: uploadedBytes,
              totalBytes: bytes.length,
            ),
          );
        } catch (error, stack) {
          if (!cancelled && !(cancelToken?.isCancelled ?? false)) {
            failure ??= error;
            failureStack ??= stack;
            signalAbort();
          }
          return;
        }
      }
    }

    try {
      final workerCount = min(mobileAttachmentUploadConcurrency, chunks.length);
      final workersDone = Future.wait(
        List<Future<void>>.generate(workerCount, (_) => worker()),
      );
      await Future.any<void>([workersDone, abortCompleter.future]);

      if (cancelled || (cancelToken?.isCancelled ?? false)) {
        await sendCancelOnce();
        throw const MobileAttachmentUploadCancelled();
      }
      if (failure != null) {
        await sendCancelOnce();
        Error.throwWithStackTrace(failure!, failureStack!);
      }
    } finally {
      removeCancelListener?.call();
    }

    if (cancelToken?.isCancelled ?? false) {
      await sendCancelOnce();
      throw const MobileAttachmentUploadCancelled();
    }

    final finishRaw = await _rpc.call(MobileAttachmentMethods.uploadFinish, {
      'uploadId': uploadId,
    });
    final finish = MobileAttachmentUploadFinishResult.fromJson(
      finishRaw as Map<String, dynamic>,
    );
    return finish.attachment;
  }

  Future<MobileAttachmentReadData> readAttachmentThumb(
    String attachmentId, {
    String? threadId,
  }) => _readAttachment(attachmentId, variant: 'thumb', threadId: threadId);

  Future<MobileAttachmentReadData> readAttachmentFull(
    String attachmentId, {
    String? threadId,
    void Function(int received, int total)? onProgress,
  }) => _readAttachment(
    attachmentId,
    variant: 'full',
    threadId: threadId,
    onProgress: onProgress,
  );

  Future<MobileAttachmentReadData> _readAttachment(
    String attachmentId, {
    required String variant,
    String? threadId,
    void Function(int received, int total)? onProgress,
  }) async {
    if (!supportsAttachments) {
      throw const ConnectionFailure('update-desktop');
    }
    if (attachmentId.isEmpty || attachmentId.length > 128) {
      throw ArgumentError.value(
        attachmentId,
        'attachmentId',
        'Invalid attachmentId',
      );
    }
    if (threadId != null && threadId.isEmpty) {
      throw ArgumentError.value(threadId, 'threadId', 'Must not be empty');
    }

    final builder = BytesBuilder(copy: false);
    MobileAttachmentRef? attachment;
    String? mimeType;
    int? expectedTotal;
    int? offset;

    while (true) {
      final raw = await _rpc.call(MobileAttachmentMethods.read, {
        'threadId': ?threadId,
        'attachmentId': attachmentId,
        'variant': variant,
        'offset': ?offset,
      });
      final page = MobileAttachmentReadResult.fromJson(
        raw as Map<String, dynamic>,
      );
      attachment ??= page.attachment;
      mimeType ??= page.mimeType;
      expectedTotal ??= page.totalBytes;
      if (page.totalBytes != expectedTotal) {
        throw const FormatException('Attachment size changed while reading');
      }
      final chunk = base64Decode(page.dataBase64);
      builder.add(chunk);
      onProgress?.call(builder.length, expectedTotal);

      final next = page.nextOffset;
      if (next == null) {
        if (builder.length != expectedTotal) {
          throw const FormatException('Truncated attachment payload');
        }
        return (
          attachment: attachment,
          mimeType: mimeType,
          bytes: builder.takeBytes(),
        );
      }
      if (next <= (offset ?? 0) ||
          next != builder.length ||
          next >= expectedTotal) {
        throw const FormatException('Invalid attachment read offset');
      }
      offset = next;
    }
  }
}
