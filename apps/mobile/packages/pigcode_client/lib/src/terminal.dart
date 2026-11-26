import 'dart:async';
import 'dart:convert';

import 'package:pigcode_transport/pigcode_transport.dart';

import '../host_rpc.dart';

const mobileTerminalMaxPerThread = 6;
const mobileTerminalColsMin = 20;
const mobileTerminalColsMax = 500;
const mobileTerminalRowsMin = 5;
const mobileTerminalRowsMax = 200;
const mobileTerminalWriteMaxBytes = 16 * 1024;
const mobileTerminalOutputChunkBytes = 24 * 1024;

const _maxSafeInt = 9007199254740991;

abstract final class MobileTerminalMethods {
  static const list = 'mobile.terminal.list';
  static const open = 'mobile.terminal.open';
  static const attach = 'mobile.terminal.attach';
  static const detach = 'mobile.terminal.detach';
  static const write = 'mobile.terminal.write';
  static const resize = 'mobile.terminal.resize';
  static const close = 'mobile.terminal.close';
}

abstract final class MobileTerminalNotifications {
  static const output = 'mobile.terminal.output';
  static const exit = 'mobile.terminal.exit';
}

enum MobileTerminalOrigin {
  desktop('desktop'),
  mobile('mobile');

  const MobileTerminalOrigin(this.wireValue);
  final String wireValue;

  static MobileTerminalOrigin fromWireValue(String value) {
    for (final origin in values) {
      if (origin.wireValue == value) return origin;
    }
    throw FormatException('Invalid terminal origin: $value');
  }
}

int _parseNonNegativeInt(Object? raw, String field) {
  if (raw is! int || raw < 0 || raw > _maxSafeInt) {
    throw FormatException('Invalid $field');
  }
  return raw;
}

int _parsePositiveInt(Object? raw, String field) {
  if (raw is! int || raw < 1 || raw > _maxSafeInt) {
    throw FormatException('Invalid $field');
  }
  return raw;
}

String _parseNonEmptyString(Object? raw, String field) {
  if (raw is! String || raw.isEmpty) {
    throw FormatException('Invalid $field');
  }
  return raw;
}

final class MobileTerminalSummary {
  const MobileTerminalSummary({
    required this.id,
    required this.threadId,
    required this.shell,
    required this.cwdLabel,
    required this.cols,
    required this.rows,
    required this.cursor,
    required this.origin,
    required this.writable,
    required this.createdAt,
  });

  final String id;
  final String threadId;
  final String shell;
  final String cwdLabel;
  final int cols;
  final int rows;
  final int cursor;
  final MobileTerminalOrigin origin;
  final bool writable;
  final String createdAt;

  factory MobileTerminalSummary.fromJson(Map<String, dynamic> json) {
    final originRaw = _parseNonEmptyString(json['origin'], 'origin');
    final writable = json['writable'];
    if (writable is! bool) {
      throw const FormatException('Invalid writable');
    }
    return MobileTerminalSummary(
      id: _parseNonEmptyString(json['id'], 'id'),
      threadId: _parseNonEmptyString(json['threadId'], 'threadId'),
      shell: _parseNonEmptyString(json['shell'], 'shell'),
      cwdLabel: _parseNonEmptyString(json['cwdLabel'], 'cwdLabel'),
      cols: _parsePositiveInt(json['cols'], 'cols'),
      rows: _parsePositiveInt(json['rows'], 'rows'),
      cursor: _parseNonNegativeInt(json['cursor'], 'cursor'),
      origin: MobileTerminalOrigin.fromWireValue(originRaw),
      writable: writable,
      createdAt: _parseNonEmptyString(json['createdAt'], 'createdAt'),
    );
  }

  Map<String, Object?> toJson() => {
    'id': id,
    'threadId': threadId,
    'shell': shell,
    'cwdLabel': cwdLabel,
    'cols': cols,
    'rows': rows,
    'cursor': cursor,
    'origin': origin.wireValue,
    'writable': writable,
    'createdAt': createdAt,
  };
}

final class MobileTerminalAttachResult {
  const MobileTerminalAttachResult({
    required this.terminal,
    required this.cursor,
    required this.replayChunks,
    required this.truncated,
  });

  final MobileTerminalSummary terminal;
  final int cursor;
  final int replayChunks;
  final bool truncated;

  factory MobileTerminalAttachResult.fromJson(Map<String, dynamic> json) {
    final terminalRaw = json['terminal'];
    final truncated = json['truncated'];
    if (terminalRaw is! Map<String, dynamic> || truncated is! bool) {
      throw const FormatException('Invalid mobile.terminal.attach result');
    }
    return MobileTerminalAttachResult(
      terminal: MobileTerminalSummary.fromJson(terminalRaw),
      cursor: _parseNonNegativeInt(json['cursor'], 'cursor'),
      replayChunks: _parseNonNegativeInt(json['replayChunks'], 'replayChunks'),
      truncated: truncated,
    );
  }

  Map<String, Object?> toJson() => {
    'terminal': terminal.toJson(),
    'cursor': cursor,
    'replayChunks': replayChunks,
    'truncated': truncated,
  };
}

final class MobileTerminalResizeResult {
  const MobileTerminalResizeResult({required this.cols, required this.rows});

  final int cols;
  final int rows;

  factory MobileTerminalResizeResult.fromJson(Map<String, dynamic> json) {
    return MobileTerminalResizeResult(
      cols: _parsePositiveInt(json['cols'], 'cols'),
      rows: _parsePositiveInt(json['rows'], 'rows'),
    );
  }
}

final class MobileTerminalOutputEvent {
  const MobileTerminalOutputEvent({
    required this.terminalId,
    required this.data,
    required this.cursor,
    this.replay = false,
    this.overflow = false,
  });

  final String terminalId;
  final String data;
  final int cursor;
  final bool replay;
  final bool overflow;

  static MobileTerminalOutputEvent? tryParse(Map<String, dynamic> params) {
    final terminalId = params['terminalId'];
    final dataBase64 = params['dataBase64'];
    final cursor = params['cursor'];
    if (terminalId is! String ||
        terminalId.isEmpty ||
        dataBase64 is! String ||
        cursor is! int ||
        cursor < 0) {
      return null;
    }
    try {
      final decoded = dataBase64.isEmpty
          ? ''
          : utf8.decode(base64Decode(dataBase64), allowMalformed: true);
      return MobileTerminalOutputEvent(
        terminalId: terminalId,
        data: decoded,
        cursor: cursor,
        replay: params['replay'] == true,
        overflow: params['overflow'] == true,
      );
    } catch (_) {
      return null;
    }
  }
}

final class MobileTerminalExitEvent {
  const MobileTerminalExitEvent({
    required this.terminalId,
    required this.exitCode,
  });

  final String terminalId;
  final int exitCode;

  static MobileTerminalExitEvent? tryParse(Map<String, dynamic> params) {
    final terminalId = params['terminalId'];
    final exitCode = params['exitCode'];
    if (terminalId is! String || terminalId.isEmpty || exitCode is! int) {
      return null;
    }
    return MobileTerminalExitEvent(terminalId: terminalId, exitCode: exitCode);
  }
}

/// 按 UTF-8 字节上限切分字符串，绝不切裂 UTF-16 代理对或多字节 UTF-8 字符。
List<String> splitUtf8Chunks(String text, int maxBytes) {
  if (text.isEmpty) return const [];
  final limit = maxBytes < 4 ? 4 : maxBytes;
  final chunks = <String>[];
  var start = 0;
  var bytes = 0;
  var i = 0;
  while (i < text.length) {
    final code = text.codeUnitAt(i);
    var units = 1;
    final int charBytes;
    if (code >= 0xD800 &&
        code <= 0xDBFF &&
        i + 1 < text.length &&
        text.codeUnitAt(i + 1) >= 0xDC00 &&
        text.codeUnitAt(i + 1) <= 0xDFFF) {
      units = 2;
      charBytes = 4;
    } else if (code <= 0x7F) {
      charBytes = 1;
    } else if (code <= 0x7FF) {
      charBytes = 2;
    } else {
      charBytes = 3;
    }
    if (bytes + charBytes > limit && i > start) {
      chunks.add(text.substring(start, i));
      start = i;
      bytes = 0;
    }
    bytes += charBytes;
    i += units;
  }
  if (start < text.length) {
    chunks.add(text.substring(start));
  }
  return chunks;
}

class MobileTerminalClient {
  MobileTerminalClient(this._rpc, {this.supportsTerminal = true});

  final HostRequests _rpc;
  final bool supportsTerminal;

  Stream<MobileTerminalOutputEvent>? _outputs;
  Stream<MobileTerminalExitEvent>? _exits;

  /// 实时终端输出与回放分片广播流。
  Stream<MobileTerminalOutputEvent> get outputs => _outputs ??= _rpc
      .notifications
      .where(
        (msg) =>
            msg['method'] == MobileTerminalNotifications.output &&
            msg['params'] is Map<String, dynamic>,
      )
      .map(
        (msg) => MobileTerminalOutputEvent.tryParse(
          msg['params'] as Map<String, dynamic>,
        ),
      )
      .where((event) => event != null)
      .cast<MobileTerminalOutputEvent>();

  /// 终端进程退出广播流。
  Stream<MobileTerminalExitEvent> get exits => _exits ??= _rpc.notifications
      .where(
        (msg) =>
            msg['method'] == MobileTerminalNotifications.exit &&
            msg['params'] is Map<String, dynamic>,
      )
      .map(
        (msg) => MobileTerminalExitEvent.tryParse(
          msg['params'] as Map<String, dynamic>,
        ),
      )
      .where((event) => event != null)
      .cast<MobileTerminalExitEvent>();

  void _requireSupported() {
    if (!supportsTerminal) {
      throw const ConnectionFailure('update-desktop');
    }
  }

  Map<String, dynamic> _asMap(Object? raw, String method) {
    if (raw is! Map<String, dynamic>) {
      throw FormatException('Invalid $method result');
    }
    return raw;
  }

  Future<List<MobileTerminalSummary>> list({required String threadId}) async {
    _requireSupported();
    final raw = await _rpc.call(MobileTerminalMethods.list, {
      'threadId': threadId,
    });
    final map = _asMap(raw, MobileTerminalMethods.list);
    final items = map['terminals'];
    if (items is! List) {
      throw const FormatException('Invalid mobile.terminal.list result');
    }
    return items
        .map(
          (item) => MobileTerminalSummary.fromJson(
            _asMap(item, MobileTerminalMethods.list),
          ),
        )
        .toList(growable: false);
  }

  Future<MobileTerminalSummary> open({
    required String threadId,
    required int cols,
    required int rows,
  }) async {
    _requireSupported();
    final raw = await _rpc.call(MobileTerminalMethods.open, {
      'threadId': threadId,
      'cols': cols.clamp(mobileTerminalColsMin, mobileTerminalColsMax),
      'rows': rows.clamp(mobileTerminalRowsMin, mobileTerminalRowsMax),
    });
    final map = _asMap(raw, MobileTerminalMethods.open);
    return MobileTerminalSummary.fromJson(
      _asMap(map['terminal'], MobileTerminalMethods.open),
    );
  }

  Future<MobileTerminalAttachResult> attach({
    required String threadId,
    required String terminalId,
    int? afterCursor,
    int? cols,
    int? rows,
  }) async {
    _requireSupported();
    final params = <String, Object?>{
      'threadId': threadId,
      'terminalId': terminalId,
    };
    if (afterCursor != null && afterCursor >= 0) {
      params['afterCursor'] = afterCursor;
    }
    if (cols != null && rows != null) {
      params['cols'] = cols.clamp(mobileTerminalColsMin, mobileTerminalColsMax);
      params['rows'] = rows.clamp(mobileTerminalRowsMin, mobileTerminalRowsMax);
    }
    final raw = await _rpc.call(MobileTerminalMethods.attach, params);
    return MobileTerminalAttachResult.fromJson(
      _asMap(raw, MobileTerminalMethods.attach),
    );
  }

  Future<void> detach({required String terminalId}) async {
    _requireSupported();
    await _rpc.call(MobileTerminalMethods.detach, {'terminalId': terminalId});
  }

  Future<void> write({required String terminalId, required String data}) async {
    _requireSupported();
    if (data.isEmpty) return;
    final chunks = splitUtf8Chunks(data, mobileTerminalWriteMaxBytes);
    for (final chunk in chunks) {
      final encoded = base64Encode(utf8.encode(chunk));
      await _rpc.call(MobileTerminalMethods.write, {
        'terminalId': terminalId,
        'dataBase64': encoded,
      });
    }
  }

  Future<MobileTerminalResizeResult> resize({
    required String terminalId,
    required int cols,
    required int rows,
  }) async {
    _requireSupported();
    final raw = await _rpc.call(MobileTerminalMethods.resize, {
      'terminalId': terminalId,
      'cols': cols.clamp(mobileTerminalColsMin, mobileTerminalColsMax),
      'rows': rows.clamp(mobileTerminalRowsMin, mobileTerminalRowsMax),
    });
    return MobileTerminalResizeResult.fromJson(
      _asMap(raw, MobileTerminalMethods.resize),
    );
  }

  Future<void> close({required String terminalId}) async {
    _requireSupported();
    await _rpc.call(MobileTerminalMethods.close, {'terminalId': terminalId});
  }
}
