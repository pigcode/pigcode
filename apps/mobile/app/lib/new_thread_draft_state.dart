import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:uuid/uuid.dart';

import 'composer/composer_catalog.dart';
import 'local_drafts.dart';
import 'mobile_secure_storage.dart';

class NewThreadForm {
  const NewThreadForm({
    this.text = '',
    this.projectId,
    this.instanceId,
    this.modelId,
    this.instanceLabel,
    this.modelLabel,
    this.permissionMode,
    this.planMode = false,
  });

  final String text;
  final String? projectId;
  final String? instanceId;
  final String? modelId;
  final String? instanceLabel;
  final String? modelLabel;
  final MobileDraftPermission? permissionMode;
  final bool planMode;

  factory NewThreadForm.fromJson(Map<String, dynamic> json) => NewThreadForm(
    text: json['text'] as String,
    projectId: json['projectId'] as String?,
    instanceId: json['instanceId'] as String?,
    modelId: json['modelId'] as String?,
    instanceLabel: json['instanceLabel'] as String?,
    modelLabel: json['modelLabel'] as String?,
    permissionMode: json['permissionMode'] == null
        ? null
        : MobileDraftPermission.fromWire(json['permissionMode'] as String),
    planMode: json['planMode'] as bool? ?? false,
  );

  Map<String, Object?> toJson() => {
    'text': text,
    'projectId': projectId,
    'instanceId': instanceId,
    'modelId': modelId,
    'instanceLabel': instanceLabel,
    'modelLabel': modelLabel,
    'permissionMode': permissionMode?.wire,
    'planMode': planMode,
  };

  NewThreadForm copyWith({
    String? text,
    String? projectId,
    String? instanceId,
    String? modelId,
    String? instanceLabel,
    String? modelLabel,
    MobileDraftPermission? permissionMode,
    bool? planMode,
    bool resetModel = false,
  }) => NewThreadForm(
    text: text ?? this.text,
    projectId: projectId ?? this.projectId,
    instanceId: instanceId ?? this.instanceId,
    modelId: resetModel ? null : modelId ?? this.modelId,
    instanceLabel: instanceLabel ?? this.instanceLabel,
    modelLabel: resetModel ? null : modelLabel ?? this.modelLabel,
    permissionMode: permissionMode ?? this.permissionMode,
    planMode: planMode ?? this.planMode,
  );

  bool matches(MobileDraftCreateParams command) =>
      text == command.text &&
      projectId == command.projectId &&
      instanceId == command.instanceId &&
      modelId == command.modelId &&
      permissionMode == command.permissionMode &&
      planMode == (command.planMode ?? false);
}

class _DraftRecord {
  const _DraftRecord(this.form, this.pending);
  final NewThreadForm form;
  final MobileDraftCreateParams? pending;
}

/// One encrypted slot stores the editable draft and its outstanding command.
class NewThreadDraftStorage {
  NewThreadDraftStorage(String computerKey, String deviceId)
    : _lease = ComputerStorageLease(computerKey),
      _key = '${_computerPrefix(computerKey)}$deviceId';

  final ComputerStorageLease _lease;
  final String _key;

  static String _computerPrefix(String computerKey) =>
      '$newThreadDraftPrefix$computerKey.';

  Future<_DraftRecord> _read() async {
    final raw = _lease.valid ? await mobileSecureStorage.read(key: _key) : null;
    if (raw == null) return const _DraftRecord(NewThreadForm(), null);
    final json = jsonDecode(raw) as Map<String, dynamic>;
    final pending = json['pending'] as Map<String, dynamic>?;
    final form = json['form'] as Map<String, dynamic>?;
    return _DraftRecord(
      form == null ? const NewThreadForm() : NewThreadForm.fromJson(form),
      pending == null ? null : MobileDraftCreateParams.fromJson(pending),
    );
  }

  Future<_DraftRecord> _load() => withLocalDrafts(_read);

  Future<_DraftRecord> _update(_DraftRecord Function(_DraftRecord) update) =>
      withLocalDrafts(() async {
        final current = await _read();
        if (!_lease.valid) return current;
        final next = update(current);
        if (!identical(current, next)) {
          await mobileSecureStorage.write(
            key: _key,
            value: jsonEncode({
              'form': next.form.toJson(),
              'pending': next.pending?.toJson(),
            }),
          );
          if (!identical(current.form, next.form)) {
            await retainLocalDraft(
              _key,
              hasDraft:
                  next.form.text.isNotEmpty ||
                  next.form.projectId != null ||
                  next.form.instanceId != null ||
                  next.form.modelId != null ||
                  next.form.permissionMode != null ||
                  next.form.planMode,
            );
          }
        }
        return next;
      });
}

typedef DraftTarget = ({
  MobileConnection? connection,
  String computerKey,
  String deviceId,
  DraftEntry entry,
});

/// A project shortcut applies once when opening the draft, not on reconnect.
class DraftEntry {
  DraftEntry(this._project);
  String? _project;

  String? takeProject() {
    final project = _project;
    _project = null;
    return project;
  }
}

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
    : _store = NewThreadDraftStorage(target.computerKey, target.deviceId);

  final DraftTarget target;
  final NewThreadDraftStorage _store;
  MobileDraftCommands get _api => target.connection!.drafts;

  @override
  Future<NewThreadDraftState> build() async {
    final preferredProject = target.entry.takeProject();
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
    if (command != null && target.connection != null && ref.mounted) {
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
    if (!ref.mounted) return;
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

  Future<void> submit(
    NewThreadForm form, {
    String? effort,
    bool? fast,
    bool? ultracode,
    bool? planMode,
    List<MobileThreadReference>? references,
  }) async {
    if (target.connection == null ||
        state.value?.pending != null ||
        !_begin()) {
      return;
    }
    try {
      final supported = connectionSupportsComposerControls(target.connection);
      final normalizedEffort = effort?.trim();
      final effectivePlanMode = supported && (planMode ?? form.planMode);
      final command = MobileDraftCreateParams(
        commandId: const Uuid().v4(),
        projectId: form.projectId!,
        instanceId: form.instanceId!,
        modelId: form.modelId,
        permissionMode: form.permissionMode!,
        text: form.text,
        effort: supported &&
                normalizedEffort != null &&
                normalizedEffort.isNotEmpty
            ? normalizedEffort
            : null,
        fast: supported && fast == true ? true : null,
        ultracode: supported && ultracode == true ? true : null,
        planMode: effectivePlanMode ? true : null,
        references:
            supported && references != null && references.isNotEmpty
                ? references
                : null,
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
    if (target.connection == null || command == null || !_begin()) return;
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
