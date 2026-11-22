import 'dart:convert';

import 'mobile_secure_storage.dart';

const _threadDraftPrefix = 'pigcode.mobile.thread-draft.v1.';
const newThreadDraftPrefix = 'pigcode.mobile.new-thread.v1.';
const _draftIndex = 'pigcode.mobile.draft-recency.v1';
const _draftMutex = 'pigcode.local-draft-storage';
const localDraftLimit = 30;

Future<T> withLocalDrafts<T>(Future<T> Function() body) =>
    withComputerStorage(_draftMutex, body);

Future<List<String>> _draftsByRecency() async {
  final raw = await mobileSecureStorage.read(key: _draftIndex);
  if (raw == null) return [];
  try {
    return (jsonDecode(raw) as List)
        .whereType<String>()
        .where(
          (key) =>
              key.startsWith(_threadDraftPrefix) ||
              key.startsWith(newThreadDraftPrefix),
        )
        .toSet()
        .toList();
  } on FormatException {
    return [];
  } on TypeError {
    return [];
  }
}

/// Call while holding the draft lock, after saving the edited slot.
Future<void> retainLocalDraft(String key, {required bool hasDraft}) async {
  final keys = (await _draftsByRecency())..remove(key);
  if (hasDraft) keys.insert(0, key);
  while (keys.length > localDraftLimit) {
    final evicted = keys.removeLast();
    if (evicted.startsWith(newThreadDraftPrefix)) {
      final raw = await mobileSecureStorage.read(key: evicted);
      if (raw != null) {
        final data = jsonDecode(raw) as Map<String, dynamic>;
        final pending = data['pending'];
        if (pending != null) {
          // A command awaiting its receipt is separate from its editable draft.
          await mobileSecureStorage.write(
            key: evicted,
            value: jsonEncode({'pending': pending}),
          );
          continue;
        }
      }
    }
    if (evicted.startsWith(_threadDraftPrefix)) {
      final draft = _ThreadDraft.decode(
        await mobileSecureStorage.read(key: evicted),
      );
      // A withdrawal awaiting local acknowledgement is still recoverable work.
      if (draft.withdrawal != null) continue;
    }
    await mobileSecureStorage.delete(key: evicted);
  }
  await mobileSecureStorage.write(key: _draftIndex, value: jsonEncode(keys));
}

Future<void> clearLocalDraftPrefix(String prefix) => withLocalDrafts(() async {
  await deleteSecurePrefix(prefix);
  final keys = (await _draftsByRecency())
    ..removeWhere((key) => key.startsWith(prefix));
  await mobileSecureStorage.write(key: _draftIndex, value: jsonEncode(keys));
});

Future<void> clearComputerDrafts(String computerKey) async {
  invalidateComputerStorage(computerKey);
  await clearLocalDraftPrefix('$_threadDraftPrefix$computerKey.');
  await clearLocalDraftPrefix('$newThreadDraftPrefix$computerKey.');
}

Future<void> clearDraftsOnInstall() => withLocalDrafts(() async {
  await deleteSecurePrefix(_threadDraftPrefix);
  await deleteSecurePrefix(newThreadDraftPrefix);
  await mobileSecureStorage.delete(key: _draftIndex);
});

class ThreadDraftStorage {
  ThreadDraftStorage(String computerKey, String threadId)
    : _lease = ComputerStorageLease(computerKey),
      _key =
          '$_threadDraftPrefix$computerKey.${base64Url.encode(utf8.encode(threadId))}';

  final ComputerStorageLease _lease;
  final String _key;

  Future<String> read() => withLocalDrafts(() async {
    if (!_lease.valid) return '';
    final draft = await _read();
    return _lease.valid ? draft.text : '';
  });

  Future<void> save(String text, {String? previous}) =>
      withLocalDrafts(() async {
        if (!_lease.valid) return;
        final old = await _read();
        final withdrawal = old.withdrawal;
        final next =
            withdrawal != null &&
                previous != null &&
                text != old.text &&
                old.text == _append(previous, withdrawal.text)
            ? _append(text, withdrawal.text)
            : text;
        await _write(_ThreadDraft(next, withdrawal));
      });

  Future<void> clearIfMatches(String text) => withLocalDrafts(() async {
    if (!_lease.valid) return;
    final old = await _read();
    if (old.text == text) await _write(_ThreadDraft('', old.withdrawal));
  });

  Future<({String text, bool appended})> restoreWithdrawal(
    String commandId,
    String text, {
    required String fallback,
  }) => withLocalDrafts(() async {
    if (!_lease.valid) throw StateError('Computer authorization changed');
    final raw = await mobileSecureStorage.read(key: _key);
    final old = _ThreadDraft.decode(raw);
    if (old.withdrawal?.id == commandId) {
      return (text: old.text, appended: false);
    }
    final next = _append(raw == null ? fallback : old.text, text);
    await _write(_ThreadDraft(next, (id: commandId, text: text)));
    return (text: next, appended: true);
  });

  Future<void> finishWithdrawal(String commandId) => withLocalDrafts(() async {
    if (!_lease.valid) return;
    final old = await _read();
    if (old.withdrawal?.id == commandId) await _write(_ThreadDraft(old.text));
  });

  Future<_ThreadDraft> _read() async =>
      _ThreadDraft.decode(await mobileSecureStorage.read(key: _key));

  Future<void> _write(_ThreadDraft draft) async {
    if (!_lease.valid) return;
    if (draft.text.isEmpty && draft.withdrawal == null) {
      await mobileSecureStorage.delete(key: _key);
    } else {
      await mobileSecureStorage.write(
        key: _key,
        value: jsonEncode(draft.toJson()),
      );
    }
    await retainLocalDraft(_key, hasDraft: draft.text.isNotEmpty);
  }

  static String _append(String draft, String text) =>
      draft.isEmpty ? text : '$draft\n$text';
}

typedef _Withdrawal = ({String id, String text});

class _ThreadDraft {
  const _ThreadDraft(this.text, [this.withdrawal]);

  final String text;
  final _Withdrawal? withdrawal;

  static _ThreadDraft decode(String? raw) {
    if (raw == null) return const _ThreadDraft('');
    final data = jsonDecode(raw) as Map<String, dynamic>;
    final value = data['withdrawal'] as Map<String, dynamic>?;
    return _ThreadDraft(
      data['text'] as String? ?? '',
      value == null
          ? null
          : (id: value['id'] as String, text: value['text'] as String),
    );
  }

  Map<String, Object?> toJson() => {
    'text': text,
    if (withdrawal case final value?)
      'withdrawal': {'id': value.id, 'text': value.text},
  };
}
