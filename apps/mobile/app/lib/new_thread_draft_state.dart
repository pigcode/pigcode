import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:uuid/uuid.dart';

import 'mobile_secure_storage.dart';

class NewThreadForm {
  const NewThreadForm({
    this.text = '',
    this.projectId,
    this.instanceId,
    this.modelId,
    this.permissionMode,
  });

  final String text;
  final String? projectId;
  final String? instanceId;
  final String? modelId;
  final MobileDraftPermission? permissionMode;

  factory NewThreadForm.fromJson(Map<String, dynamic> json) => NewThreadForm(
    text: json['text'] as String,
    projectId: json['projectId'] as String?,
    instanceId: json['instanceId'] as String?,
    modelId: json['modelId'] as String?,
    permissionMode: json['permissionMode'] == null
        ? null
        : MobileDraftPermission.fromWire(json['permissionMode'] as String),
  );

  Map<String, Object?> toJson() => {
    'text': text,
    'projectId': projectId,
    'instanceId': instanceId,
    'modelId': modelId,
    'permissionMode': permissionMode?.wire,
  };

  NewThreadForm copyWith({
    String? text,
    String? projectId,
    String? instanceId,
    String? modelId,
    MobileDraftPermission? permissionMode,
    bool resetModel = false,
  }) => NewThreadForm(
    text: text ?? this.text,
    projectId: projectId ?? this.projectId,
    instanceId: instanceId ?? this.instanceId,
    modelId: resetModel ? null : modelId ?? this.modelId,
    permissionMode: permissionMode ?? this.permissionMode,
  );

  bool matches(MobileDraftCreateParams command) =>
      text == command.text &&
      projectId == command.projectId &&
      instanceId == command.instanceId &&
      modelId == command.modelId &&
      permissionMode == command.permissionMode;
}

class _DraftRecord {
  const _DraftRecord(this.form, this.pending);
  final NewThreadForm form;
  final MobileDraftCreateParams? pending;
}

/// One encrypted slot stores the editable draft and its outstanding command.
class NewThreadDraftStorage {
  NewThreadDraftStorage._(MobileConnection connection)
    : _computerKey = connection.computer.computerKey,
      _key =
          '${_computerPrefix(connection.computer.computerKey)}${connection.deviceId}';

  static const _prefix = 'pigcode.mobile.new-thread.v1.';
  final String _computerKey;
  final String _key;

  static String _computerPrefix(String computerKey) => '$_prefix$computerKey.';

  static Future<void> clearForComputer(String computerKey) =>
      withComputerStorage(
        computerKey,
        () => deleteSecurePrefix(_computerPrefix(computerKey)),
      );

  static Future<void> clearOnInstall() => deleteSecurePrefix(_prefix);

  Future<_DraftRecord> _read() async {
    final raw = await mobileSecureStorage.read(key: _key);
    if (raw == null) return const _DraftRecord(NewThreadForm(), null);
    final json = jsonDecode(raw) as Map<String, dynamic>;
    final pending = json['pending'] as Map<String, dynamic>?;
    return _DraftRecord(
      NewThreadForm.fromJson(json['form'] as Map<String, dynamic>),
      pending == null ? null : MobileDraftCreateParams.fromJson(pending),
    );
  }

  Future<_DraftRecord> _load() => withComputerStorage(_computerKey, _read);

  Future<_DraftRecord> _update(_DraftRecord Function(_DraftRecord) update) =>
      withComputerStorage(_computerKey, () async {
        final current = await _read();
        final next = update(current);
        if (!identical(current, next)) {
          await mobileSecureStorage.write(
            key: _key,
            value: jsonEncode({
              'form': next.form.toJson(),
              'pending': next.pending?.toJson(),
            }),
          );
        }
        return next;
      });
}

typedef DraftTarget = (MobileConnection connection, String? projectId);

class NewThreadDraftState {
  const NewThreadDraftState({
    required this.form,
    this.pending,
    this.receipt,
    this.working = false,
    this.notice,
    this.selectionUnavailable = false,
  });

  final NewThreadForm form;
  final MobileDraftCreateParams? pending;
  final MobileDraftReceipt? receipt;
  final bool working;
  final String? notice;
  final bool selectionUnavailable;
}

final newThreadDraftProvider = AsyncNotifierProvider.autoDispose
    .family<NewThreadDraftController, NewThreadDraftState, DraftTarget>(
      NewThreadDraftController.new,
    );

class NewThreadDraftController extends AsyncNotifier<NewThreadDraftState> {
  NewThreadDraftController(this.target)
    : _store = NewThreadDraftStorage._(target.$1);

  final DraftTarget target;
  final NewThreadDraftStorage _store;
  MobileDraftCommands get _api => target.$1.drafts;

  @override
  Future<NewThreadDraftState> build() async {
    final preferredProject = target.$2;
    final draft = preferredProject == null
        ? await _store._load()
        : await _store._update(
            (current) => current.pending == null
                ? _DraftRecord(
                    current.form.copyWith(projectId: preferredProject),
                    null,
                  )
                : current,
          );
    final command = draft.pending;
    if (command != null && ref.mounted) {
      try {
        final receipt = await _api.receipt(command.commandId);
        if (receipt != null && ref.mounted) {
          final resolved = await _saveReceipt(command, receipt);
          return NewThreadDraftState(
            form: resolved.form,
            pending: resolved.pending,
            receipt: resolved.pending == null ? receipt : null,
          );
        }
      } on MobileRpcFailure catch (error) {
        if (error.problem.code == 'RESOURCE_NOT_AVAILABLE' && ref.mounted) {
          return _inaccessible(command);
        }
      } catch (_) {
        // Preserve the original command for another lookup.
      }
    }
    return NewThreadDraftState(form: draft.form, pending: command);
  }

  void edit(NewThreadForm form) {
    final current = state.value;
    if (current == null || current.working) return;
    state = AsyncData(
      NewThreadDraftState(form: form, pending: current.pending),
    );
    unawaited(_saveEdit(form));
  }

  Future<void> _saveEdit(NewThreadForm form) async {
    try {
      await _store._update((draft) => _DraftRecord(form, draft.pending));
    } catch (_) {
      if (ref.mounted && identical(state.value?.form, form)) {
        _notice('暂时无法保存草稿。');
      }
    }
  }

  Future<void> submit(NewThreadForm form) async {
    if (state.value?.pending != null || !_begin()) return;
    try {
      final command = MobileDraftCreateParams(
        commandId: const Uuid().v4(),
        projectId: form.projectId!,
        instanceId: form.instanceId!,
        modelId: form.modelId,
        permissionMode: form.permissionMode!,
        text: form.text,
      );
      final retained = await _store._update(
        (draft) => draft.pending == null ? _DraftRecord(form, command) : draft,
      );
      if (!ref.mounted) return;
      state = AsyncData(
        NewThreadDraftState(
          form: retained.form,
          pending: retained.pending,
          working: true,
        ),
      );
      if (retained.pending?.commandId == command.commandId) {
        await _transmit(command);
      }
    } catch (_) {
      _notice('首发操作未能保存或确认。');
    } finally {
      _end();
    }
  }

  Future<void> check({bool retry = false}) async {
    final command = state.value?.pending;
    if (command == null || !_begin()) return;
    try {
      final receipt = await _api.receipt(command.commandId);
      if (receipt != null) {
        await _accept(command, receipt);
      } else if (retry) {
        await _transmit(command);
      }
    } on MobileRpcFailure catch (error) {
      if (error.problem.code == 'RESOURCE_NOT_AVAILABLE' && ref.mounted) {
        await _showInaccessible(command);
      } else {
        _notice(error.problem.message);
      }
    } catch (_) {
      _notice('暂时无法确认，可以稍后查回执。');
    } finally {
      _end();
    }
  }

  Future<void> _transmit(MobileDraftCreateParams command) async {
    try {
      await _accept(command, await _api.create(command));
    } on MobileRpcFailure catch (error) {
      if (error.problem.code == 'RESOURCE_NOT_AVAILABLE' && ref.mounted) {
        await _showInaccessible(command);
      } else if (error.problem.retryable == true) {
        _notice('首发结果待确认。');
      } else {
        final draft = await _store._update(
          (draft) => draft.pending?.commandId == command.commandId
              ? _DraftRecord(draft.form, null)
              : draft,
        );
        if (ref.mounted) {
          state = AsyncData(
            NewThreadDraftState(
              form: draft.form,
              pending: draft.pending,
              notice: error.problem.message,
              selectionUnavailable:
                  error.problem.code == 'DRAFT_SELECTION_UNAVAILABLE',
            ),
          );
        }
      }
    } catch (_) {
      _notice('首发结果待确认。');
    }
  }

  Future<_DraftRecord> _saveReceipt(
    MobileDraftCreateParams command,
    MobileDraftReceipt receipt,
  ) {
    if (receipt.commandId != command.commandId ||
        receipt.projectId != command.projectId) {
      throw const FormatException('Unexpected draft receipt');
    }
    return _complete(command);
  }

  Future<_DraftRecord> _complete(MobileDraftCreateParams command) =>
      _store._update((draft) {
        if (!ref.mounted || draft.pending?.commandId != command.commandId) {
          return draft;
        }
        final form = draft.form.matches(command)
            ? const NewThreadForm()
            : draft.form;
        return _DraftRecord(form, null);
      });

  Future<NewThreadDraftState> _inaccessible(
    MobileDraftCreateParams command,
  ) async {
    final draft = await _complete(command);
    return NewThreadDraftState(
      form: draft.form,
      pending: draft.pending,
      notice: '首发已受理，原会话暂不可访问。',
    );
  }

  Future<void> _showInaccessible(MobileDraftCreateParams command) async {
    try {
      final draft = await _inaccessible(command);
      if (ref.mounted) state = AsyncData(draft);
    } catch (_) {
      _notice('原会话暂不可访问，本机待确认记录暂时无法更新。');
    }
  }

  Future<void> _accept(
    MobileDraftCreateParams command,
    MobileDraftReceipt receipt,
  ) async {
    if (!ref.mounted) return;
    final draft = await _saveReceipt(command, receipt);
    if (ref.mounted) {
      state = AsyncData(
        NewThreadDraftState(
          form: draft.form,
          pending: draft.pending,
          receipt: draft.pending == null ? receipt : null,
        ),
      );
    }
  }

  bool _begin() {
    final current = state.value;
    if (!ref.mounted || current == null || current.working) return false;
    state = AsyncData(
      NewThreadDraftState(
        form: current.form,
        pending: current.pending,
        working: true,
      ),
    );
    return true;
  }

  void _end() {
    if (!ref.mounted) return;
    final current = state.value;
    if (current?.working != true) return;
    state = AsyncData(
      NewThreadDraftState(
        form: current!.form,
        pending: current.pending,
        notice: current.notice,
      ),
    );
  }

  void _notice(String notice) {
    if (!ref.mounted || state.value == null) return;
    final current = state.requireValue;
    state = AsyncData(
      NewThreadDraftState(
        form: current.form,
        pending: current.pending,
        working: current.working,
        notice: notice,
      ),
    );
  }
}
