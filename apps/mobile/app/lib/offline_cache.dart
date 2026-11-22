import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pigcode_client/pigcode_client.dart';

import 'mobile_secure_storage.dart';

const offlineMaxEntries = 32;
const offlineMaxEntryBytes = 256 * 1024;
const offlineMaxBytes = 2 * 1024 * 1024;
const _sidebarId = '';
const _keyPrefix = 'pigcode.mobile.offline-key.v1.';

final offlineCacheProvider = Provider<OfflineCacheStore>(
  (_) => OfflineCacheStore(directory: _applicationCache),
);

Future<Directory> _applicationCache() async {
  final root = await getApplicationSupportDirectory();
  return Directory(_under(root.path, 'pigcode-offline-v1'));
}

String _under(String directory, String file) =>
    '$directory${Platform.pathSeparator}$file';

int _jsonBytes(Object? data) => utf8.encode(jsonEncode(data)).length;

class CachedTimeline {
  const CachedTimeline(this.snapshot, this.syncedAt);

  final TimelineSnapshot snapshot;
  final DateTime syncedAt;
}

/// Bounded authenticated snapshots. A lease belongs to one local pairing.
class OfflineCacheStore {
  OfflineCacheStore({required this.directory});

  final Future<Directory> Function() directory;
  final _cipher = AesGcm.with256bits();

  ComputerOfflineCache open(String computerKey) =>
      ComputerOfflineCache._(this, ComputerStorageLease(computerKey));

  Future<void> clear(String computerKey) {
    invalidateComputerStorage(computerKey);
    return withComputerStorage(computerKey, () async {
      try {
        await mobileSecureStorage.delete(key: '$_keyPrefix$computerKey');
      } finally {
        final file = await _file(computerKey);
        final temporary = File('${file.path}.tmp');
        if (await file.exists()) await file.delete();
        if (await temporary.exists()) await temporary.delete();
      }
    });
  }

  Future<void> clearOnInstall() async {
    await deleteSecurePrefix(_keyPrefix);
    final root = await directory();
    if (await root.exists()) await root.delete(recursive: true);
  }

  Future<File> _file(String computerKey) async {
    final hash = await Sha256().hash(utf8.encode(computerKey));
    final name = base64Url.encode(hash.bytes).replaceAll('=', '');
    return File(_under((await directory()).path, '$name.bin'));
  }

  List<int> _binding(String computerKey) =>
      utf8.encode('pigcode.mobile.offline.v1/$computerKey');

  Future<SecretKey?> _key(String computerKey) async {
    final raw = await mobileSecureStorage.read(key: '$_keyPrefix$computerKey');
    if (raw == null) return null;
    try {
      final bytes = base64Url.decode(raw);
      return bytes.length == 32 ? SecretKey(bytes) : null;
    } on FormatException {
      return null;
    }
  }

  Future<_CacheBook> _read(File file, String computerKey) async {
    if (!await file.exists()) return _CacheBook();
    final size = await file.length();
    if (size <= 1 || size > offlineMaxBytes) return _CacheBook();
    final key = await _key(computerKey);
    if (key == null) return _CacheBook();
    try {
      final bytes = await file.readAsBytes();
      if (bytes.first != 1) return _CacheBook();
      final box = SecretBox.fromConcatenation(
        bytes.sublist(1),
        nonceLength: _cipher.nonceLength,
        macLength: _cipher.macAlgorithm.macLength,
      );
      final clear = await _cipher.decrypt(
        box,
        secretKey: key,
        aad: _binding(computerKey),
      );
      return _CacheBook.fromJson(
        jsonDecode(utf8.decode(clear)) as Map<String, dynamic>,
      );
    } on SecretBoxAuthenticationError {
      return _CacheBook();
    } on FormatException {
      return _CacheBook();
    } on ArgumentError {
      return _CacheBook();
    } on TypeError {
      return _CacheBook();
    }
  }

  Future<void> _write(File file, String computerKey, _CacheBook book) async {
    final existing = await _key(computerKey);
    final key = existing ?? await _cipher.newSecretKey();
    if (existing == null) {
      await mobileSecureStorage.write(
        key: '$_keyPrefix$computerKey',
        value: base64Url.encode(await key.extractBytes()),
      );
    }
    final box = await _cipher.encrypt(
      utf8.encode(jsonEncode(book.toJson())),
      secretKey: key,
      aad: _binding(computerKey),
    );
    final encrypted = box.concatenation();
    final bytes = Uint8List(encrypted.length + 1)
      ..[0] = 1
      ..setRange(1, encrypted.length + 1, encrypted);
    await file.parent.create(recursive: true);
    final temporary = File('${file.path}.tmp');
    await temporary.writeAsBytes(bytes, flush: true);
    await temporary.rename(file.path);
  }

  Future<T?> _access<T>(
    ComputerStorageLease lease,
    T Function(_CacheBook book) operate, {
    bool bestEffortWrite = false,
  }) => withComputerStorage(lease.computerKey, () async {
    if (!lease.valid) return null;
    final file = await _file(lease.computerKey);
    final book = await _read(file, lease.computerKey);
    if (!lease.valid) return null;
    final result = operate(book);
    if (book.changed && lease.valid) {
      final writing = _write(file, lease.computerKey, book);
      if (bestEffortWrite) {
        await writing.catchError((Object _) {});
      } else {
        await writing;
      }
    }
    return lease.valid ? result : null;
  });
}

class ComputerOfflineCache {
  ComputerOfflineCache._(this._store, this._lease);

  final OfflineCacheStore _store;
  final ComputerStorageLease _lease;

  Future<SidebarSnapshot?> readSidebar() async {
    final value = await _store._access(_lease, (book) => book.read(_sidebarId));
    if (value == null) return null;
    return SidebarSnapshot(
      projects: (value['projects'] as List)
          .map(
            (json) =>
                MobileProjectSummary.fromJson(json as Map<String, dynamic>),
          )
          .toList(),
      threads: (value['threads'] as List)
          .map(
            (json) =>
                MobileThreadSummary.fromJson(json as Map<String, dynamic>),
          )
          .toList(),
      syncedAt: DateTime.parse(value['syncedAt'] as String),
    );
  }

  Future<void> saveSidebar(SidebarSnapshot snapshot) async {
    await _store._access(_lease, (book) {
      final threads = snapshot.threads.map((thread) => thread.id).toSet();
      book.removeWhere((id) => id.isNotEmpty && !threads.contains(id));
      book.put(_sidebarId, _boundedSidebar(snapshot));
    });
  }

  Future<CachedTimeline?> readTimeline(String threadId) async {
    final value = await _store._access(
      _lease,
      (book) => book.read(threadId),
      bestEffortWrite: true,
    );
    if (value == null) return null;
    return CachedTimeline(
      TimelineSnapshot(
        events: (value['events'] as List)
            .map(
              (json) =>
                  MobileTimelineEvent.fromJson(json as Map<String, dynamic>),
            )
            .toList(),
        through: value['through'] as int,
        cursor: value['cursor'] as int,
        nextBefore: value['nextBefore'] as int?,
        live: null,
      ),
      DateTime.parse(value['syncedAt'] as String),
    );
  }

  Future<void> saveTimeline(
    String threadId,
    TimelineSnapshot snapshot,
    DateTime syncedAt,
  ) async {
    await _store._access(
      _lease,
      (book) => book.put(threadId, _boundedTimeline(snapshot, syncedAt)),
    );
  }
}

Map<String, Object?> _boundedSidebar(SidebarSnapshot snapshot) {
  final projects = <Map<String, Object?>>[];
  final threads = <Map<String, Object?>>[];
  final projectIds = <String>{};
  var bytes = 256;
  for (final project in snapshot.projects) {
    final json = project.toJson();
    final size = _jsonBytes(json) + 1;
    if (bytes + size > offlineMaxEntryBytes) break;
    bytes += size;
    projects.add(json);
    projectIds.add(project.id);
  }
  for (final thread in snapshot.threads) {
    if (!projectIds.contains(thread.projectId)) continue;
    final json = thread.toJson();
    final size = _jsonBytes(json) + 1;
    if (bytes + size > offlineMaxEntryBytes) break;
    bytes += size;
    threads.add(json);
  }
  return {
    'projects': projects,
    'threads': threads,
    'syncedAt': snapshot.syncedAt.toUtc().toIso8601String(),
  };
}

Map<String, Object?> _boundedTimeline(
  TimelineSnapshot snapshot,
  DateTime syncedAt,
) {
  final events = <Map<String, Object?>>[];
  var bytes = 256;
  var oldest = snapshot.cursor;
  for (final event in snapshot.events.reversed) {
    final json = event.toJson();
    bytes += _jsonBytes(json) + 1;
    if (bytes > offlineMaxEntryBytes) break;
    oldest = event.seq;
    events.add(json);
  }
  final trimmed = events.length < snapshot.events.length;
  return {
    'events': events.reversed.toList(),
    'through': trimmed ? snapshot.cursor : snapshot.through,
    'cursor': snapshot.cursor,
    'nextBefore': trimmed ? oldest : snapshot.nextBefore,
    'syncedAt': syncedAt.toUtc().toIso8601String(),
  };
}

class _CacheBook {
  _CacheBook();

  factory _CacheBook.fromJson(Map<String, dynamic> json) {
    final book = _CacheBook().._clock = json['clock'] as int;
    for (final row in json['entries'] as List) {
      final data = row as Map<String, dynamic>;
      book._entries[data['id'] as String] = (
        touched: data['touched'] as int,
        data: data['data'] as Map<String, dynamic>,
      );
    }
    return book;
  }

  final _entries = <String, ({int touched, Map<String, dynamic> data})>{};
  var _clock = 0;
  bool changed = false;

  Map<String, Object?> toJson() => {
    'clock': _clock,
    'entries': [
      for (final entry in _entries.entries)
        {
          'id': entry.key,
          'touched': entry.value.touched,
          'data': entry.value.data,
        },
    ],
  };

  Map<String, dynamic>? read(String id) {
    final entry = _entries[id];
    if (entry != null && id != _sidebarId) {
      _entries[id] = (touched: ++_clock, data: entry.data);
      changed = true;
    }
    return entry?.data;
  }

  void removeWhere(bool Function(String id) predicate) {
    final length = _entries.length;
    _entries.removeWhere((key, _) => predicate(key));
    if (_entries.length != length) changed = true;
  }

  void put(String id, Map<String, dynamic> data) {
    if (_jsonBytes(data) > offlineMaxEntryBytes) return;
    _entries[id] = (touched: ++_clock, data: data);
    final oldest =
        _entries.entries.where((entry) => entry.key != _sidebarId).toList()
          ..sort((a, b) => a.value.touched.compareTo(b.value.touched));
    var bytes = _jsonBytes(toJson()) + 64;
    for (final entry in oldest) {
      if (_entries.length <= offlineMaxEntries && bytes <= offlineMaxBytes) {
        break;
      }
      bytes -=
          _jsonBytes({
            'id': entry.key,
            'touched': entry.value.touched,
            'data': entry.value.data,
          }) +
          1;
      _entries.remove(entry.key);
    }
    changed = true;
  }
}
