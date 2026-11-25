import 'dart:convert';

import 'package:pigcode_client/pigcode_client.dart';

import 'attachments/attachment_cache.dart';
import 'attachments/draft_attachment.dart';
import 'mobile_secure_storage.dart';

const _threadDraftPrefix = 'pigcode.mobile.thread-draft.v1.';
const newThreadDraftPrefix = 'pigcode.mobile.new-thread.v1.';
const _draftIndex = 'pigcode.mobile.draft-recency.v1';
const _draftMutex = 'pigcode.local-draft-storage';
const localDraftLimit = 30;

String? _computerKeyFromDraftKey(String key) {
  final String rest;
  if (key.startsWith(_threadDraftPrefix)) {
    rest = key.substring(_threadDraftPrefix.length);
  } else if (key.startsWith(newThreadDraftPrefix)) {
    rest = key.substring(newThreadDraftPrefix.length);
  } else {
    return null;
  }
  final dot = rest.lastIndexOf('.');
  return dot > 0 ? rest.substring(0, dot) : null;
}

Future<void> _deleteDraftAttachmentFiles(
  String computerKey,
  List<DraftAttachmentRecord> attachments, {
  AttachmentCacheStore? cache,
}) async {
  if (attachments.isEmpty) return;
  final store = cache ?? AttachmentCacheStore.defaultInstance;
  for (final item in attachments) {
    if (item.draftFileName case final fileName?) {
      await store.deleteDraftFile(computerKey, fileName);
    }
  }
}

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
Future<void> retainLocalDraft(
  String key, {
  required bool hasDraft,
  AttachmentCacheStore? attachmentCache,
}) async {
  final keys = (await _draftsByRecency())..remove(key);
  if (hasDraft) keys.insert(0, key);
  while (keys.length > localDraftLimit) {
    final evicted = keys.removeLast();
    final evictedComputer = _computerKeyFromDraftKey(evicted);
    if (evicted.startsWith(newThreadDraftPrefix)) {
      final raw = await mobileSecureStorage.read(key: evicted);
      if (raw != null) {
        final data = jsonDecode(raw) as Map<String, dynamic>;
        final form = data['form'] as Map<String, dynamic>?;
        final formAttachments = decodeDraftAttachmentRecords(
          form?['attachments'],
        );
        final pending = data['pending'];
        if (pending != null) {
          // A command awaiting its receipt is separate from its editable draft.
          await mobileSecureStorage.write(
            key: evicted,
            value: jsonEncode({'pending': pending}),
          );
          if (evictedComputer != null) {
            await _deleteDraftAttachmentFiles(
              evictedComputer,
              formAttachments,
              cache: attachmentCache,
            );
          }
          continue;
        }
        if (evictedComputer != null) {
          await _deleteDraftAttachmentFiles(
            evictedComputer,
            formAttachments,
            cache: attachmentCache,
          );
        }
      }
    }
    if (evicted.startsWith(_threadDraftPrefix)) {
      final draft = _ThreadDraft.decode(
        await mobileSecureStorage.read(key: evicted),
      );
      // A withdrawal awaiting local acknowledgement is still recoverable work.
      if (draft.withdrawal != null) continue;
      if (evictedComputer != null) {
        await _deleteDraftAttachmentFiles(
          evictedComputer,
          draft.attachments,
          cache: attachmentCache,
        );
      }
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

Future<void> clearComputerDrafts(
  String computerKey, {
  AttachmentCacheStore? attachmentCache,
}) async {
  invalidateComputerStorage(computerKey);
  await clearLocalDraftPrefix('$_threadDraftPrefix$computerKey.');
  await clearLocalDraftPrefix('$newThreadDraftPrefix$computerKey.');
  await (attachmentCache ?? AttachmentCacheStore.defaultInstance)
      .clearComputerDraftFiles(computerKey);
}

Future<void> clearDraftsOnInstall({AttachmentCacheStore? attachmentCache}) =>
    withLocalDrafts(() async {
      await deleteSecurePrefix(_threadDraftPrefix);
      await deleteSecurePrefix(newThreadDraftPrefix);
      await mobileSecureStorage.delete(key: _draftIndex);
      await (attachmentCache ?? AttachmentCacheStore.defaultInstance)
          .clearAllAttachmentCaches();
    });

class ThreadDraftStorage {
  ThreadDraftStorage(
    this._computerKey,
    String threadId, {
    this._attachmentCache,
  }) : _lease = ComputerStorageLease(_computerKey),
       _key =
           '$_threadDraftPrefix$_computerKey.${base64Url.encode(utf8.encode(threadId))}';

  final String _computerKey;
  final AttachmentCacheStore? _attachmentCache;
  final ComputerStorageLease _lease;
  final String _key;

  Future<String> read() => withLocalDrafts(() async {
    if (!_lease.valid) return '';
    final draft = await _read();
    return _lease.valid ? draft.text : '';
  });

  Future<({String text, List<DraftAttachmentRecord> attachments})> readFull() =>
      withLocalDrafts(() async {
        if (!_lease.valid) {
          return (text: '', attachments: const <DraftAttachmentRecord>[]);
        }
        final draft = await _read();
        if (!_lease.valid) {
          return (text: '', attachments: const <DraftAttachmentRecord>[]);
        }
        return (text: draft.text, attachments: draft.attachments);
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
        await _write(_ThreadDraft(next, withdrawal, old.attachments));
      });

  Future<void> saveAttachments(List<DraftAttachmentRecord> attachments) =>
      withLocalDrafts(() async {
        if (!_lease.valid) return;
        final old = await _read();
        await _write(_ThreadDraft(old.text, old.withdrawal, attachments));
      });

  Future<void> appendAttachments(List<DraftAttachmentRecord> added) =>
      withLocalDrafts(() async {
        if (!_lease.valid || added.isEmpty) return;
        final old = await _read();
        final merged = <DraftAttachmentRecord>[...old.attachments, ...added];
        final capped = merged.length > mobileMaxMessageAttachments
            ? merged.sublist(0, mobileMaxMessageAttachments)
            : merged;
        await _write(
          _ThreadDraft(old.text, old.withdrawal, List.unmodifiable(capped)),
        );
      });

  Future<void> clearIfMatches(String text) =>
      clearIfMatchesContent(text);

  Future<void> clearIfMatchesContent(
    String text, {
    List<String> attachmentIds = const [],
  }) => withLocalDrafts(() async {
    if (!_lease.valid) return;
    final old = await _read();
    final textMatches = old.text == text;
    final clearedText = textMatches ? '' : old.text;
    var remainingAttachments = old.attachments;
    final removedAttachments = <DraftAttachmentRecord>[];
    if (attachmentIds.isNotEmpty && old.attachments.isNotEmpty) {
      final idSet = attachmentIds.toSet();
      remainingAttachments = [
        for (final item in old.attachments)
          if (item.remoteRef != null && idSet.contains(item.remoteRef!.id))
            ...() {
              removedAttachments.add(item);
              return const <DraftAttachmentRecord>[];
            }()
          else
            item,
      ];
    }
    if (textMatches || removedAttachments.isNotEmpty) {
      await _write(
        _ThreadDraft(clearedText, old.withdrawal, remainingAttachments),
      );
      if (removedAttachments.isNotEmpty) {
        await _deleteDraftAttachmentFiles(
          _computerKey,
          removedAttachments,
          cache: _attachmentCache,
        );
      }
    }
  });

  Future<({String text, bool appended})> restoreWithdrawal(
    String commandId,
    String text, {
    required String fallback,
  }) async {
    final result = await restoreWithdrawalWithAttachments(
      commandId,
      text,
      fallback: fallback,
    );
    return (text: result.text, appended: result.appended);
  }

  Future<
    ({
      String text,
      List<MobileAttachmentRef> attachments,
      bool appended,
    })
  >
  restoreWithdrawalWithAttachments(
    String commandId,
    String text, {
    required String fallback,
    List<MobileAttachmentRef> attachments = const [],
  }) => withLocalDrafts(() async {
    if (!_lease.valid) throw StateError('Computer authorization changed');
    final raw = await mobileSecureStorage.read(key: _key);
    final old = _ThreadDraft.decode(raw);
    if (old.withdrawal?.id == commandId) {
      return (
        text: old.text,
        attachments: old.withdrawal!.attachments,
        appended: false,
      );
    }
    final nextText = text.isEmpty
        ? (raw == null ? fallback : old.text)
        : _append(raw == null ? fallback : old.text, text);
    final mergedAttachments = _mergeWithdrawnAttachments(
      old.attachments,
      attachments,
    );
    await _write(
      _ThreadDraft(
        nextText,
        (id: commandId, text: text, attachments: attachments),
        mergedAttachments,
      ),
    );
    return (text: nextText, attachments: attachments, appended: true);
  });

  Future<void> finishWithdrawal(String commandId) => withLocalDrafts(() async {
    if (!_lease.valid) return;
    final old = await _read();
    if (old.withdrawal?.id == commandId) {
      await _write(_ThreadDraft(old.text, null, old.attachments));
    }
  });

  Future<_ThreadDraft> _read() async =>
      _ThreadDraft.decode(await mobileSecureStorage.read(key: _key));

  Future<void> _write(_ThreadDraft draft) async {
    if (!_lease.valid) return;
    if (draft.text.isEmpty &&
        draft.attachments.isEmpty &&
        draft.withdrawal == null) {
      await mobileSecureStorage.delete(key: _key);
    } else {
      await mobileSecureStorage.write(
        key: _key,
        value: jsonEncode(draft.toJson()),
      );
    }
    await retainLocalDraft(
      _key,
      hasDraft: draft.text.isNotEmpty || draft.attachments.isNotEmpty,
      attachmentCache: _attachmentCache,
    );
  }

  static String _append(String draft, String text) =>
      draft.isEmpty ? text : '$draft\n$text';

  static List<DraftAttachmentRecord> _mergeWithdrawnAttachments(
    List<DraftAttachmentRecord> existing,
    List<MobileAttachmentRef> withdrawn,
  ) {
    if (withdrawn.isEmpty) return existing;
    final merged = [...existing];
    final existingIds = {
      for (final item in merged)
        if (item.remoteRef case final ref?) ref.id,
    };
    for (final ref in withdrawn) {
      if (existingIds.contains(ref.id)) continue;
      if (merged.length >= mobileMaxMessageAttachments) break;
      merged.add(
        DraftAttachmentRecord(
          localId: 'ref-${ref.id}',
          fileName: ref.fileName,
          mimeType: ref.mimeType,
          sizeBytes: ref.sizeBytes,
          width: ref.width,
          height: ref.height,
          remoteRef: ref,
          status: 'uploaded',
        ),
      );
      existingIds.add(ref.id);
    }
    return List<DraftAttachmentRecord>.unmodifiable(merged);
  }
}

typedef _Withdrawal = ({
  String id,
  String text,
  List<MobileAttachmentRef> attachments,
});

class _ThreadDraft {
  const _ThreadDraft(
    this.text, [
    this.withdrawal,
    this.attachments = const [],
  ]);

  final String text;
  final _Withdrawal? withdrawal;
  final List<DraftAttachmentRecord> attachments;

  static _ThreadDraft decode(String? raw) {
    if (raw == null) return const _ThreadDraft('');
    final data = jsonDecode(raw) as Map<String, dynamic>;
    final value = data['withdrawal'] as Map<String, dynamic>?;
    return _ThreadDraft(
      data['text'] as String? ?? '',
      value == null
          ? null
          : (
              id: value['id'] as String,
              text: value['text'] as String,
              attachments: parseMobileAttachmentRefs(value['attachments']),
            ),
      decodeDraftAttachmentRecords(data['attachments']),
    );
  }

  Map<String, Object?> toJson() => {
    'text': text,
    if (withdrawal case final value?)
      'withdrawal': {
        'id': value.id,
        'text': value.text,
        if (value.attachments.isNotEmpty)
          'attachments': value.attachments.map((item) => item.toJson()).toList(),
      },
    if (attachments.isNotEmpty)
      'attachments': attachments.map((item) => item.toJson()).toList(),
  };
}
