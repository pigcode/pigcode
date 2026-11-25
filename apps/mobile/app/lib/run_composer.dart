import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';

import 'attachments/attachment_cache.dart';
import 'attachments/composer_attachment_strip.dart';
import 'attachments/composer_attachments_controller.dart';
import 'attachments/image_compressor.dart';
import 'attachments/image_viewer_page.dart';
import 'composer/composer_catalog.dart';
import 'composer/composer_status_banner.dart';
import 'composer/composer_suggestion_panel.dart';
import 'composer/composer_tokens.dart';
import 'composer/context_meter.dart';
import 'composer/mention_editing_controller.dart';
import 'composer/mobile_composer_card.dart';
import 'composer/model_picker_sheet.dart';
import 'composer/model_preferences.dart';
import 'local_drafts.dart';
import 'message_queue_panel.dart';
import 'run_command_journal.dart';
import 'run_composer_state.dart';
import 'timeline/timeline_tokens.dart';
import 'workspace_icon.dart';

class RunComposer extends ConsumerStatefulWidget {
  const RunComposer({
    super.key,
    required this.connection,
    required this.threadId,
    required this.online,
    this.projectId,
    this.projects = const [],
    this.threads = const [],
    this.stoppableRunId,
    this.queueRevision = 0,
    this.composer,
    this.wrapInput,
    this.draft,
    this.attachments,
    this.supportsAttachments,
    this.leading,
    this.trailing,
    this.optimisticBubbles = false,
    this.glass = false,
    this.onSendReserved,
  });

  final MobileConnection connection;
  final String threadId;
  final String? projectId;
  final List<MobileProjectSummary> projects;
  final List<MobileThreadSummary> threads;
  final bool online;
  final String? stoppableRunId;
  final int queueRevision;
  final MobileThreadComposerState? composer;
  final Widget Function(Widget)? wrapInput;
  final TextEditingController? draft;
  final ComposerAttachmentsController? attachments;
  final bool? supportsAttachments;
  final Widget? leading;
  final Widget? trailing;
  final bool optimisticBubbles;
  final bool glass;
  final void Function(PendingSend saved, List<MobileAttachmentRef> attachments)?
  onSendReserved;

  @override
  ConsumerState<RunComposer> createState() => _RunComposerState();
}

class _RunComposerState extends ConsumerState<RunComposer> {
  final _localDraft = ComposerTextEditingController();
  final _focusNode = FocusNode();
  final _selectionNotifier = ValueNotifier<ComposerSelectionSnapshot>(
    const ComposerSelectionSnapshot(),
  );
  ComposerAttachmentsController? _localAttachments;
  late ThreadDraftStorage _draftStore;
  MobileThreadComposerState? _composerOverride;
  String? _composerNotice;
  bool _updatingComposer = false;
  bool _submittingAttachments = false;
  bool _rememberedAttachmentsSupport = false;
  ComposerSelectionSnapshot _latestSelection =
      const ComposerSelectionSnapshot();

  TextEditingController get _draft => widget.draft ?? _localDraft;
  ComposerAttachmentsController get _attachments =>
      widget.attachments ?? _localAttachments!;

  MobileThreadComposerState? get _composer =>
      _composerOverride ?? widget.composer;

  bool get _supportsAttachments =>
      widget.supportsAttachments ??
      (_rememberedAttachmentsSupport ||
          connectionSupportsAttachments(widget.connection));

  @override
  void initState() {
    super.initState();
    _rememberedAttachmentsSupport = connectionSupportsAttachments(
      widget.connection,
    );
    _draftStore = ThreadDraftStorage(
      widget.connection.computer.computerKey,
      widget.threadId,
      attachmentCache: ref.read(attachmentCacheProvider),
    );
    _initLocalAttachmentsIfNeeded();
    _attachments.updateConnection(widget.connection, online: widget.online);
  }

  void _initLocalAttachmentsIfNeeded() {
    if (widget.attachments != null) {
      _localAttachments?.dispose();
      _localAttachments = null;
      return;
    }
    _localAttachments?.dispose();
    final store = _draftStore;
    final controller = ComposerAttachmentsController(
      computerKey: widget.connection.computer.computerKey,
      cache: ref.read(attachmentCacheProvider),
      compressor: ref.read(imageCompressorProvider),
      connection: widget.connection,
      online: widget.online,
      onDraftChanged: (records) =>
          unawaited(store.saveAttachments(records).catchError((Object _) {})),
    );
    _localAttachments = controller;
    unawaited(
      store.readFull().then((restored) {
        if (!mounted || !identical(_localAttachments, controller)) return;
        if (restored.attachments.isNotEmpty) {
          unawaited(
            controller.restoreFromDraft(
              restored.attachments,
              threadId: widget.threadId,
            ),
          );
        }
      }, onError: (Object _) {}),
    );
  }

  @override
  void didUpdateWidget(covariant RunComposer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (connectionSupportsAttachments(widget.connection)) {
      _rememberedAttachmentsSupport = true;
    }
    final targetChanged =
        oldWidget.threadId != widget.threadId ||
        oldWidget.connection.computer.computerKey !=
            widget.connection.computer.computerKey;
    if (oldWidget.threadId != widget.threadId ||
        !identical(oldWidget.connection, widget.connection)) {
      _composerOverride = null;
      _composerNotice = null;
      _updatingComposer = false;
    } else if (!identical(oldWidget.composer, widget.composer)) {
      _composerOverride = null;
    }
    if (targetChanged || !identical(oldWidget.attachments, widget.attachments)) {
      _draftStore = ThreadDraftStorage(
        widget.connection.computer.computerKey,
        widget.threadId,
        attachmentCache: ref.read(attachmentCacheProvider),
      );
      _initLocalAttachmentsIfNeeded();
    }
    _attachments.updateConnection(widget.connection, online: widget.online);
  }

  @override
  void dispose() {
    _localDraft.dispose();
    _localAttachments?.dispose();
    _focusNode.dispose();
    _selectionNotifier.dispose();
    super.dispose();
  }

  Future<void> _pickPhotos() async {
    final remaining = _attachments.remainingSlots;
    if (remaining <= 0) {
      setState(
        () => _composerNotice =
            '每条消息最多添加 $mobileMaxMessageAttachments 张图片。',
      );
      return;
    }
    try {
      final picked = await ref
          .read(mobileImagePickerProvider)
          .pickFromGallery(limit: remaining);
      if (!mounted || picked.isEmpty) return;
      await _attachments.addLocalFiles([
        for (final file in picked) file.path,
      ]);
    } on PlatformException {
      if (mounted) {
        setState(() => _composerNotice = '无法访问相册，请在系统设置中允许 Pigcode 访问照片。');
      }
    } catch (_) {
      if (mounted) {
        setState(() => _composerNotice = '无法打开相册，请重试。');
      }
    }
  }

  Future<void> _takePhoto() async {
    if (_attachments.remainingSlots <= 0) {
      setState(
        () => _composerNotice =
            '每条消息最多添加 $mobileMaxMessageAttachments 张图片。',
      );
      return;
    }
    try {
      final picked = await ref
          .read(mobileImagePickerProvider)
          .captureFromCamera();
      if (!mounted || picked == null) return;
      await _attachments.addLocalFiles([picked.path]);
    } on PlatformException {
      if (mounted) {
        setState(() => _composerNotice = '无法使用相机，请在系统设置中允许 Pigcode 使用相机。');
      }
    } catch (_) {
      if (mounted) {
        setState(() => _composerNotice = '无法启动拍照，请重试。');
      }
    }
  }

  Future<Uint8List?> _loadRemoteFull(String attachmentId) async {
    final cache = ref.read(attachmentCacheProvider);
    final computerKey = widget.connection.computer.computerKey;
    final cached = await cache.readFull(computerKey, attachmentId);
    if (cached != null) return cached;
    if (!widget.online || !connectionSupportsAttachments(widget.connection)) {
      return null;
    }
    final data = await widget.connection.readAttachmentFull(
      attachmentId,
      threadId: widget.threadId,
    );
    unawaited(cache.writeFull(computerKey, attachmentId, data.bytes));
    return data.bytes;
  }

  Future<void> _handleSend(
    String text, {
    required ResolvedComposerRunOptions runOptions,
    required bool supportsControls,
    required RunComposerController controller,
  }) async {
    if (_submittingAttachments) return;
    final draft = _draft;
    final references = draft is ComposerTextEditingController
        ? draft.resolveReferences(text)
        : const <MobileThreadReference>[];

    List<String>? attachmentIds;
    var committedRefs = const <MobileAttachmentRef>[];
    if (_attachments.hasItems) {
      setState(() => _submittingAttachments = true);
      try {
        attachmentIds = await _attachments.ensureAllUploaded();
      } finally {
        if (mounted) setState(() => _submittingAttachments = false);
      }
      if (!mounted || attachmentIds == null) return;
      final idSet = attachmentIds.toSet();
      committedRefs = [
        for (final item in _attachments.items)
          if (item.remoteRef case final ref? when idSet.contains(ref.id)) ref,
      ];
    }

    unawaited(
      controller.send(
        text,
        effort: runOptions.effort,
        fast: runOptions.fast,
        ultracode: runOptions.ultracode,
        references: supportsControls && references.isNotEmpty
            ? references
            : null,
        attachmentIds:
            attachmentIds != null && attachmentIds.isNotEmpty
            ? attachmentIds
            : null,
        clearDraftImmediately: widget.optimisticBubbles,
        onReserved: widget.optimisticBubbles
            ? (saved) {
                if (!mounted) return;
                // 发送已落盘 journal 后立刻清空输入框与已选图片，消息以气泡呈现在时间线底部。
                if (_draft.text == saved.params.text) _draft.clear();
                if (saved.params.attachmentIds case final ids?
                    when ids.isNotEmpty) {
                  unawaited(_attachments.clearCommittedIds(ids));
                }
                widget.onSendReserved?.call(saved, committedRefs);
              }
            : null,
      ),
    );
  }

  void _scheduleSelectionSync(ComposerSelectionSnapshot snapshot) {
    _latestSelection = snapshot;
    if (_selectionNotifier.value == snapshot) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _selectionNotifier.value != _latestSelection) {
        _selectionNotifier.value = _latestSelection;
      }
    });
  }

  String _composerErrorMessage(Object error) {
    if (error is MobileRpcFailure) {
      return error.problem.message;
    }
    return '暂时无法更新运行设置，请重试。';
  }

  Future<void> _mutateComposer(
    Future<MobileThreadComposerState> Function() request,
  ) async {
    if (!mounted || _updatingComposer || !widget.online) return;
    final connection = widget.connection;
    final threadId = widget.threadId;
    setState(() {
      _updatingComposer = true;
      _composerNotice = null;
    });
    _selectionNotifier.value = _buildSnapshotFromState(
      composer: _composer,
      busy: true,
      notice: null,
    );
    try {
      final updated = await request();
      if (!mounted ||
          widget.threadId != threadId ||
          !identical(widget.connection, connection)) {
        return;
      }
      setState(() {
        _composerOverride = updated;
        _composerNotice = null;
        _updatingComposer = false;
      });
      _selectionNotifier.value = _buildSnapshotFromState(
        composer: updated,
        busy: false,
        notice: null,
      );
    } catch (error) {
      if (!mounted ||
          widget.threadId != threadId ||
          !identical(widget.connection, connection)) {
        return;
      }
      final message = _composerErrorMessage(error);
      setState(() {
        _composerNotice = message;
        _updatingComposer = false;
      });
      _selectionNotifier.value = _buildSnapshotFromState(
        composer: _composer,
        busy: false,
        notice: message,
      );
    }
  }

  ComposerSelectionSnapshot _buildSnapshotFromState({
    required MobileThreadComposerState? composer,
    required bool busy,
    required String? notice,
  }) => ComposerSelectionSnapshot(
    instanceId: composer?.instanceId,
    agentId: composer?.agentId,
    modelId: composer?.modelId,
    permissionMode: composer?.permissionMode,
    planMode: composer?.planMode ?? false,
    supportsPlanMode: composer?.supportsPlanMode ?? false,
    locked: widget.stoppableRunId != null,
    notice: notice,
    busy: busy,
  );

  Future<void> _openModelPicker() async {
    if (!widget.online || !connectionSupportsComposerControls(widget.connection)) {
      return;
    }
    _selectionNotifier.value = _latestSelection;
    await showMobileModelPickerSheet(
      context: context,
      connection: widget.connection,
      selection: _selectionNotifier,
      onSelectModel: (instance, model) => _mutateComposer(
        () => widget.connection.composer.switchAgent(
          threadId: widget.threadId,
          instanceId: instance.instanceId,
          modelId: model.id,
        ),
      ),
      onPermissionMode: (mode) => _mutateComposer(
        () => widget.connection.composer.setPermissionMode(
          threadId: widget.threadId,
          permissionMode: mode,
        ),
      ),
      onPlanMode: (enabled) => _mutateComposer(
        () => widget.connection.composer.setPlanMode(
          threadId: widget.threadId,
          planMode: enabled,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final provider = runComposerProvider((widget.connection, widget.threadId));
    final commandState = ref.watch(provider);
    ref.listen(provider, (previous, next) {
      const method = MobileRunMethod.runStart;
      final outcome = next.value?.outcomes[method];
      if (outcome == null ||
          identical(outcome, previous?.value?.outcomes[method])) {
        return;
      }
      if (outcome.command case PendingSend(:final params)) {
        if (outcome.receipt != null) {
          if (_draft.text == params.text) _draft.clear();
          if (params.attachmentIds case final ids? when ids.isNotEmpty) {
            unawaited(_attachments.clearCommittedIds(ids));
          }
        } else if (!widget.optimisticBubbles &&
            outcome.receipt == null &&
            _draft.text.isEmpty &&
            params.text.isNotEmpty) {
          _draft.text = params.text;
        }
      }
    });
    final controller = ref.read(provider.notifier);
    final supportsControls =
        widget.online && connectionSupportsComposerControls(widget.connection);
    final activeComposer = _composer;

    ResolvedComposerRunOptions runOptions = const ResolvedComposerRunOptions();
    Widget? effectiveTrailing = widget.trailing;
    MobileDraftInstance? currentInstance;

    if (supportsControls && activeComposer != null) {
      final preferences = ref.watch(modelPreferencesProvider);
      final optionsAsync = ref.watch(
        composerDraftOptionsProvider(widget.connection),
      );
      final instances =
          optionsAsync.value?.instances ?? const <MobileDraftInstance>[];
      currentInstance = instances
          .where((item) => item.instanceId == activeComposer.instanceId)
          .firstOrNull;
      final modelsAsync = ref.watch(
        composerDraftModelsProvider((
          widget.connection,
          activeComposer.instanceId,
        )),
      );
      final currentModel = resolveDraftModel(
        modelsAsync.value,
        activeComposer.modelId,
      );
      runOptions = resolveComposerRunOptions(
        supportsComposerControls: true,
        instanceId: activeComposer.instanceId,
        model: currentModel,
        preferences: preferences,
      );
      _scheduleSelectionSync(
        _buildSnapshotFromState(
          composer: activeComposer,
          busy: _updatingComposer,
          notice: _composerNotice,
        ),
      );
      if (effectiveTrailing == null) {
        final instanceLabel =
            currentInstance?.label ?? activeComposer.agentId;
        final modelLabel =
            currentModel?.label ??
            activeComposer.modelId ??
            currentInstance?.label ??
            '选择模型';
        effectiveTrailing = Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            MobileModelPickerChip(
              agentId: currentInstance?.agentId ?? activeComposer.agentId,
              instanceId: activeComposer.instanceId,
              accentColor: currentInstance?.accentColor,
              instanceLabel: instanceLabel,
              modelLabel: modelLabel,
              effort: runOptions.effort,
              fast: runOptions.fast == true,
              ultracode: runOptions.ultracode == true,
              planMode: activeComposer.planMode,
              permissionMode: activeComposer.permissionMode,
              defaultPermissionMode: currentInstance?.defaultPermissionMode,
              onTap: _openModelPicker,
            ),
            if (activeComposer.contextUsage case final usage?)
              MobileContextMeter(usage: usage),
          ],
        );
      }
    }

    final extraBanners = <Widget>[
      if (_composerNotice case final notice? when notice.isNotEmpty)
        _ComposerInlineNotice(
          text: notice,
          onDismiss: () => setState(() => _composerNotice = null),
        ),
    ];

    final supportsImages =
        (activeComposer?.supportsImages ?? true) &&
        (currentInstance?.supportsImages ?? true);

    final view = ListenableBuilder(
      listenable: _attachments,
      builder: (context, _) => MobileComposerMentionHost(
        connection: widget.connection,
        online: widget.online,
        controller: _draft,
        focusNode: _focusNode,
        projectId: widget.projectId,
        threadId: widget.threadId,
        instanceId: activeComposer?.instanceId,
        projects: widget.projects,
        threads: widget.threads,
        supportsPlanMode:
            supportsControls &&
            activeComposer != null &&
            (activeComposer.supportsPlanMode || activeComposer.planMode),
        permissionModes: supportsControls
            ? (currentInstance?.permissionModes ?? const [])
            : const [],
        canOpenModelPicker: supportsControls && activeComposer != null,
        onOpenModelPicker: supportsControls && activeComposer != null
            ? () => unawaited(_openModelPicker())
            : null,
        onTogglePlanMode: supportsControls && activeComposer != null
            ? () => unawaited(
                _mutateComposer(
                  () => widget.connection.composer.setPlanMode(
                    threadId: widget.threadId,
                    planMode: !activeComposer.planMode,
                  ),
                ),
              )
            : null,
        onSelectPermissionMode: supportsControls && activeComposer != null
            ? (mode) => unawaited(
                _mutateComposer(
                  () => widget.connection.composer.setPermissionMode(
                    threadId: widget.threadId,
                    permissionMode: mode,
                  ),
                ),
              )
            : null,
        externalLeading: widget.leading,
        supportsAttachments: _supportsAttachments,
        attachmentCount: _attachments.count,
        onPickPhotos: _supportsAttachments ? () => unawaited(_pickPhotos()) : null,
        onTakePhoto: _supportsAttachments ? () => unawaited(_takePhoto()) : null,
        builder: (context, leading) => RunComposerView(
          draft: _draft,
          focusNode: _focusNode,
          online: widget.online,
          stoppableRunId: widget.stoppableRunId,
          allowQueue: widget.connection.supportsQueueCommands,
          state: commandState.value,
          storageError: commandState.hasError,
          onRetryLoad: () => ref.invalidate(provider),
          onSend: (text) => unawaited(
            _handleSend(
              text,
              runOptions: runOptions,
              supportsControls: supportsControls,
              controller: controller,
            ),
          ),
          onStop: controller.stop,
          onCheck: controller.check,
          onRetry: controller.retry,
          extraBanners: extraBanners,
          attachments: _attachments,
          supportsImages: supportsImages,
          submittingAttachments: _submittingAttachments,
          loadRemoteFull: _loadRemoteFull,
          leading: leading,
          trailing: effectiveTrailing,
          optimisticBubbles: widget.optimisticBubbles,
          glass: widget.glass,
        ),
      ),
    );
    final input = widget.wrapInput?.call(view) ?? view;
    if (!widget.connection.supportsQueueCommands) return input;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        MessageQueuePanel(
          connection: widget.connection,
          threadId: widget.threadId,
          revision: widget.queueRevision,
          online: widget.online,
          onWithdraw: _restoreWithdrawal,
          onWithdrawalAcknowledged: _draftStore.finishWithdrawal,
        ),
        input,
      ],
    );
  }

  Future<void> _restoreWithdrawal(QueueReceipt receipt) async {
    final controller = _draft;
    final original = controller.text;
    final text = receipt.text ?? '';
    final restored = await _draftStore.restoreWithdrawalWithAttachments(
      receipt.commandId,
      text,
      fallback: original,
      attachments: receipt.attachments,
    );
    if (!mounted || !identical(controller, _draft)) return;
    if (text.isNotEmpty) {
      final current = controller.text;
      if (restored.appended || current == original) {
        final next = current == original
            ? restored.text
            : current.isEmpty
            ? text
            : '$current\n$text';
        controller.value = TextEditingValue(
          text: next,
          selection: TextSelection.collapsed(offset: next.length),
        );
        if (next != restored.text) {
          await _draftStore.save(next, previous: current);
        }
      }
    }
    if (receipt.attachments.isNotEmpty) {
      await _attachments.restoreCommittedRefs(
        receipt.attachments,
        threadId: widget.threadId,
      );
    }
  }
}

class _ComposerInlineNotice extends StatelessWidget {
  const _ComposerInlineNotice({required this.text, required this.onDismiss});

  final String text;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) => ComposerStatusBanner(
    tone: ComposerStatusTone.error,
    title: text,
    trailing: ComposerBannerAction(label: '知道了', onPressed: onDismiss),
  );
}

class RunComposerView extends StatelessWidget {
  const RunComposerView({
    super.key,
    required this.draft,
    required this.online,
    required this.state,
    required this.storageError,
    required this.onRetryLoad,
    required this.onSend,
    required this.onStop,
    required this.onCheck,
    required this.onRetry,
    this.focusNode,
    this.stoppableRunId,
    this.allowQueue = false,
    this.extraBanners = const [],
    this.attachments,
    this.supportsImages = true,
    this.submittingAttachments = false,
    this.loadRemoteFull,
    this.leading,
    this.trailing,
    this.optimisticBubbles = false,
    this.glass = false,
  });

  final TextEditingController draft;
  final FocusNode? focusNode;
  final bool online;
  final String? stoppableRunId;
  final bool allowQueue;
  final RunComposerState? state;
  final bool storageError;
  final VoidCallback onRetryLoad;
  final ValueChanged<String> onSend;
  final ValueChanged<String> onStop;
  final ValueChanged<MobileRunMethod> onCheck;
  final ValueChanged<MobileRunMethod> onRetry;
  final List<Widget> extraBanners;
  final ComposerAttachmentsController? attachments;
  final bool supportsImages;
  final bool submittingAttachments;
  final AttachmentBytesLoader? loadRemoteFull;
  final Widget? leading;
  final Widget? trailing;
  final bool optimisticBubbles;
  final bool glass;

  @override
  Widget build(BuildContext context) {
    final runId = stoppableRunId;

    bool enabled(MobileRunMethod method) =>
        online &&
        state != null &&
        !state!.working.contains(method) &&
        !state!.pending.containsKey(method);

    final statusBanners = <Widget>[
      ...extraBanners,
      if (storageError)
        ComposerStatusBanner(
          tone: ComposerStatusTone.error,
          title: '无法读取发送状态。',
          trailing: ComposerBannerAction(
            label: '重试读取',
            onPressed: onRetryLoad,
          ),
        ),
      if (state case final view?)
        for (final kind in MobileRunMethod.values)
          if (!(optimisticBubbles && kind == MobileRunMethod.runStart) &&
              (view.pending[kind] != null ||
                  view.notices[kind] != null ||
                  view.outcomes[kind]?.recovered == true))
            _PendingRunRow(
              kind: kind,
              draft: draft,
              state: view,
              online: online,
              onCheck: () => onCheck(kind),
              onRetry: () => onRetry(kind),
            ),
    ];

    final hintText = !online
        ? '电脑离线，消息发不出去'
        : runId != null && allowQueue
        ? '生成中 · 发出的消息会排队'
        : '回复…';

    final listenable = attachments == null
        ? draft
        : Listenable.merge([draft, attachments!]);

    return ListenableBuilder(
      listenable: listenable,
      builder: (context, _) {
        final text = draft.text;
        final hasText = text.trim().isNotEmpty;
        final attachmentController = attachments;
        final hasAttachments = attachmentController?.hasItems ?? false;
        final showAttachmentStrip =
            attachmentController != null &&
            (attachmentController.hasItems ||
                attachmentController.bannerError != null);
        final hasContent = hasText || hasAttachments;
        final tooLong = text.length > mobileCommandTextLimit;
        final canSend =
            enabled(MobileRunMethod.runStart) &&
            !submittingAttachments &&
            hasContent &&
            !tooLong;
        final banners = <Widget>[
          ...statusBanners,
          if (tooLong)
            ComposerStatusBanner(
              tone: ComposerStatusTone.error,
              title: '每条消息最多 $mobileCommandTextLimit 个字符。',
            ),
        ];
        final actions = <Widget>[
          if (runId != null)
            MobileComposerActionButton(
              tooltip: '停止本轮运行',
              glyph: WorkspaceGlyph.stop,
              offline: !online,
              onPressed: enabled(MobileRunMethod.runInterrupt)
                  ? () => onStop(runId)
                  : null,
            ),
          if (runId == null || (allowQueue && hasContent))
            MobileComposerActionButton(
              tooltip: '发送消息',
              glyph: WorkspaceGlyph.arrowUp,
              offline: !online,
              onPressed: canSend ? () => onSend(text) : null,
            ),
        ];
        return MobileComposerCard(
          controller: draft,
          focusNode: focusNode,
          inputKey: const ValueKey('run-composer-input'),
          hintText: hintText,
          offline: !online,
          glass: glass,
          onSubmitted: (_) {
            if (canSend) onSend(text);
          },
          banners: banners,
          attachments: showAttachmentStrip
              ? ComposerAttachmentStrip(
                  controller: attachmentController,
                  supportsImages: supportsImages,
                  loadRemoteFull: loadRemoteFull,
                )
              : null,
          leading: leading,
          trailing: trailing,
          actions: actions,
        );
      },
    );
  }
}

class _PendingRunRow extends StatelessWidget {
  const _PendingRunRow({
    required this.kind,
    required this.draft,
    required this.state,
    required this.online,
    required this.onCheck,
    required this.onRetry,
  });

  final MobileRunMethod kind;
  final TextEditingController draft;
  final RunComposerState state;
  final bool online;
  final VoidCallback onCheck;
  final VoidCallback onRetry;

  static String? _previewText(
    PendingSend pending,
    String currentDraftText, {
    required bool working,
  }) {
    final trimmed = pending.params.text.trim();
    if (trimmed.isNotEmpty) {
      // 输入框里仍显示同一份草稿原文时不再重复展示，避免出现两遍相同文字。
      if (currentDraftText.trim() == trimmed) return null;
      return trimmed;
    }
    if (working) return null;
    final imageCount = pending.params.attachmentIds?.length ?? 0;
    if (imageCount <= 0) return null;
    return imageCount == 1 ? '[图片]' : '[$imageCount 张图片]';
  }

  @override
  Widget build(BuildContext context) {
    final pending = state.pending[kind];
    final outcome = state.outcomes[kind];
    final recovered = outcome?.recovered == true ? outcome!.receipt : null;
    final working = state.working.contains(kind);
    final label = switch (kind) {
      MobileRunMethod.runStart => working ? '正在确认发送…' : '发送结果待确认',
      MobileRunMethod.runInterrupt => working ? '正在确认停止…' : '停止结果待确认',
    };
    final text = recovered != null
        ? switch (kind) {
            MobileRunMethod.runStart =>
              recovered.queuedMessageId == null ? '已找回发送回执' : '已找回待发回执',
            MobileRunMethod.runInterrupt => '已找回停止回执',
          }
        : state.notices[kind] ?? label;

    final tone = recovered != null
        ? ComposerStatusTone.success
        : working
        ? ComposerStatusTone.neutral
        : pending != null
        ? ComposerStatusTone.attention
        : ComposerStatusTone.error;

    return ValueListenableBuilder<TextEditingValue>(
      valueListenable: draft,
      builder: (context, value, _) {
        final colors = ComposerSurface.palette(Theme.of(context).brightness);
        final preview = pending is PendingSend
            ? _previewText(pending, value.text, working: working)
            : null;
        final canCopyRejected = switch (outcome) {
          RunCommandOutcome(
            receipt: null,
            command: PendingSend(:final params),
          )
              when params.text.isNotEmpty && value.text != params.text =>
            params.text,
          _ => null,
        };

        Widget? detail;
        if (recovered != null) {
          detail = SelectableText(
            recovered.queuedMessageId ?? recovered.runId,
            style: TimelineType.microStyle(colors.faint).copyWith(
              fontFamily: 'monospace',
              fontFamilyFallback: TimelineType.monoFallback,
            ),
          );
        } else if (preview != null) {
          detail = Text(
            preview,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TimelineType.smallStyle(colors.muted),
          );
        }

        final actions = <Widget>[
          if (pending != null && !working) ...[
            ComposerBannerAction(
              label: '查回执',
              onPressed: online ? onCheck : null,
            ),
            ComposerBannerAction(
              label: '用原编号重试',
              emphasized: true,
              onPressed: online ? onRetry : null,
            ),
          ],
          if (canCopyRejected != null)
            ComposerBannerAction(
              label: '复制原文',
              onPressed: () =>
                  Clipboard.setData(ClipboardData(text: canCopyRejected)),
            ),
        ];

        return ComposerStatusBanner(
          tone: tone,
          loading: working,
          title: text,
          detail: detail,
          actions: actions,
        );
      },
    );
  }
}
