import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

import 'attachments/attachment_cache.dart';
import 'attachments/composer_attachments_controller.dart';
import 'attachments/image_compressor.dart';
import 'composer/composer_suggestion_panel.dart';
import 'composer/mention_editing_controller.dart';
import 'local_drafts.dart';
import 'mobile_glass.dart';
import 'offline_cache.dart';
import 'offline_sync_label.dart';
import 'preview/preview_tab.dart';
import 'preview/preview_url_extractor.dart';
import 'preview/preview_webview_screen.dart';
import 'run_command_journal.dart';
import 'run_composer.dart';
import 'run_composer_state.dart';
import 'run_changes_card.dart';
import 'run_diff_screen.dart';
import 'share/share_receiver.dart';
import 'thread_read_receipt.dart';
import 'timeline/notice_line.dart';
import 'timeline/optimistic_user_bubble.dart';
import 'timeline/request_card.dart';
import 'timeline_view.dart';
import 'timeline_work.dart';
import 'workbench/file_viewer_screen.dart';
import 'workbench/mobile_workbench_screen.dart';
import 'workbench/workbench_utils.dart';

typedef _Selection = (MobileConnection, String, TimelineSnapshot?);

typedef _TimelineRead = ({TimelineSnapshot snapshot, Object? problem});
typedef RunChangesShortcut = ({int fileCount, bool hasMore, VoidCallback open});
typedef _RunChangesTarget = ({
  MobileConnection connection,
  String runId,
  int revision,
});

final _timelineProvider = AsyncNotifierProvider.autoDispose
    .family<_TimelineController, _TimelineRead, _Selection>(
      _TimelineController.new,
    );

class _TimelineController extends AsyncNotifier<_TimelineRead> {
  _TimelineController(this.selection);
  final _Selection selection;
  MobileTimeline? _timeline;

  @override
  Future<_TimelineRead> build() async {
    final (connection, threadId, previous) = selection;
    final timeline = await connection.openTimeline(
      threadId,
      resumeFrom: previous,
    );
    if (ref.mounted) {
      _timeline = timeline;
      final subscription = timeline.updates.listen((snapshot) {
        if (ref.mounted) state = AsyncData((snapshot: snapshot, problem: null));
      }, onError: (Object error, StackTrace stack) => _report(error, stack));
      ref.onDispose(() => unawaited(subscription.cancel()));
    }
    return (snapshot: timeline.snapshot!, problem: null);
  }

  void _report(Object error, StackTrace stack) {
    if (!ref.mounted) return;
    final snapshot = _timeline?.snapshot;
    state = snapshot == null
        ? AsyncError(error, stack)
        : AsyncData((snapshot: snapshot, problem: error));
  }

  Future<void> retry() async {
    final timeline = _timeline;
    if (timeline == null) {
      ref.invalidateSelf();
      return;
    }
    try {
      await timeline.refresh();
    } catch (error, stack) {
      _report(error, stack);
    }
  }

  Future<void> loadEarlier() async => _timeline?.loadEarlier();

  Future<MobileTimelineContentResult> content({
    int? seq,
    String? runId,
    String? toolId,
    required MobileTimelineContentField field,
    int? offset,
  }) => _timeline!.content(
    seq: seq,
    runId: runId,
    toolId: toolId,
    field: field,
    offset: offset,
  );
}

class TimelinePane extends ConsumerStatefulWidget {
  const TimelinePane({
    super.key,
    required this.connection,
    required this.threadId,
    required this.online,
    this.projectId,
    this.projects = const [],
    this.threads = const [],
    this.cache,
    this.computerKey,
    this.onSynced,
    this.onRunChangesChanged,
    this.onPreviewUrlsChanged,
    this.openExternalUrl,
    this.previewWebViewBuilder,
    this.reading,
    this.liveShare,
  });

  final MobileConnection? connection;
  final String threadId;
  final String? projectId;
  final List<MobileProjectSummary> projects;
  final List<MobileThreadSummary> threads;
  final bool online;
  final ComputerOfflineCache? cache;
  final String? computerKey;
  final ValueChanged<bool>? onSynced;
  final ValueChanged<RunChangesShortcut?>? onRunChangesChanged;
  final ValueChanged<List<String>>? onPreviewUrlsChanged;
  final ExternalUrlOpener? openExternalUrl;
  final PreviewWebViewBuilder? previewWebViewBuilder;
  final ({
    bool visible,
    int visit,
    bool unread,
    MobileThreadReadTarget? target,
    MobileThreadReadTarget? manualUnread,
  })?
  reading;
  final LiveShareInjection? liveShare;

  @override
  ConsumerState<TimelinePane> createState() => _TimelinePaneState();
}

class _TimelinePaneState extends ConsumerState<TimelinePane> {
  TimelineSnapshot? _latest;
  TimelineSnapshot? _resumeFrom;
  DateTime? _syncedAt;
  bool _historyReady = false;
  bool _draftReady = false;
  bool _draftError = false;
  bool _synced = false;
  _RunChangesTarget? _changesTarget;
  Future<MobileRunChangesPage>? _shortcutFiles;
  List<MobileTimelineEvent>? _changeEvents;
  MobileConnection? _changeConnection;
  List<MobileTimelineEvent>? _previewSourceEvents;
  MobileActiveRun? _previewSourceLive;
  List<String> _reportedPreviewUrls = const [];
  bool _openingChanges = false;
  String _observedText = '';
  ThreadDraftStorage? _draftStore;
  ComposerAttachmentsController? _attachments;
  bool _rememberedAttachmentsSupport = false;
  String? _handledLiveShareId;
  final _text = ComposerTextEditingController();
  double _composerHeight = 0;
  PendingSend? _lastUnconfirmedSend;
  final _optimisticAttachments = <String, List<MobileAttachmentRef>>{};

  @override
  void initState() {
    super.initState();
    _rememberedAttachmentsSupport = connectionSupportsAttachments(
      widget.connection,
    );
    _restoreHistory();
    final key = widget.computerKey;
    if (key != null) {
      final cache = ref.read(attachmentCacheProvider);
      _draftStore = ThreadDraftStorage(
        key,
        widget.threadId,
        attachmentCache: cache,
      );
      _attachments = ComposerAttachmentsController(
        computerKey: key,
        cache: cache,
        compressor: ref.read(imageCompressorProvider),
        connection: widget.connection,
        online: widget.online,
        onDraftChanged: (records) {
          final store = _draftStore;
          if (store == null) return;
          unawaited(store.saveAttachments(records).catchError((Object _) {}));
        },
      );
    }
    _text.addListener(_saveEditedText);
    _restoreDraft();
  }

  @override
  void didUpdateWidget(covariant TimelinePane oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (connectionSupportsAttachments(widget.connection)) {
      _rememberedAttachmentsSupport = true;
    }
    if (!identical(oldWidget.cache, widget.cache)) {
      _latest = null;
      _resumeFrom = null;
      _syncedAt = null;
      _restoreHistory();
    } else if (!identical(oldWidget.connection, widget.connection)) {
      _resumeFrom = _latest;
    }
    _attachments?.updateConnection(widget.connection, online: widget.online);
    _maybeApplyLiveShare();
  }

  @override
  void dispose() {
    _attachments?.dispose();
    _text.dispose();
    super.dispose();
  }

  void _restoreHistory() {
    final cache = widget.cache;
    _historyReady = cache == null;
    if (cache == null) return;
    unawaited(
      cache.readTimeline(widget.threadId).catchError((Object _) => null).then((
        history,
      ) {
        if (!mounted || !identical(widget.cache, cache)) return;
        setState(() {
          _historyReady = true;
          _latest = history?.snapshot;
          _resumeFrom = _latest;
          _syncedAt = history?.syncedAt;
        });
      }),
    );
  }

  void _restoreDraft() {
    final store = _draftStore;
    if (store == null) {
      _draftReady = true;
      _maybeApplyLiveShare();
      return;
    }
    unawaited(
      store.readFull().then(
        (restored) async {
          if (!mounted) return;
          setState(() {
            _observedText = restored.text;
            _text.text = restored.text;
            _draftReady = true;
            _draftError = false;
          });
          if (restored.attachments.isNotEmpty) {
            await _attachments?.restoreFromDraft(
              restored.attachments,
              threadId: widget.threadId,
            );
          }
          if (mounted) _maybeApplyLiveShare();
        },
        onError: (Object _) {
          if (mounted) {
            setState(() {
              _draftReady = true;
              _draftError = true;
            });
            _maybeApplyLiveShare();
          }
        },
      ),
    );
  }

  void _maybeApplyLiveShare() {
    final share = widget.liveShare;
    if (share == null ||
        share.forNewThread ||
        share.threadId != widget.threadId ||
        share.id == _handledLiveShareId ||
        !_draftReady) {
      return;
    }
    _handledLiveShareId = share.id;
    final attachments = _attachments;
    if (attachments == null) {
      share.complete();
      return;
    }
    unawaited(
      attachments
          .stageSharedImages(share.paths)
          .whenComplete(share.complete),
    );
  }

  void _saveEditedText() {
    final store = _draftStore;
    final value = _text.text;
    if (store == null || value == _observedText) return;
    final previous = _observedText;
    _observedText = value;
    unawaited(
      store
          .save(value, previous: previous)
          .then<void>(
            (_) {
              if (mounted && _draftError && _observedText == value) {
                setState(() => _draftError = false);
              }
            },
            onError: (Object _) {
              if (mounted && _observedText == value) {
                setState(() => _draftError = true);
              }
            },
          ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final connection = widget.connection;
    final threadId = widget.threadId;
    final provider = connection != null && widget.online && _historyReady
        ? _timelineProvider((connection, threadId, _resumeFrom))
        : null;
    final selected = provider == null ? null : ref.watch(provider);
    final current = selected?.value;
    if (provider != null) {
      ref.listen(provider, (previous, next) {
        final snapshot = next.value?.snapshot;
        final cache = widget.cache;
        if (snapshot == null || !widget.online) return;
        if (!identical(snapshot.events, previous?.value?.snapshot.events)) {
          final now = DateTime.now();
          _syncedAt = now;
          if (cache != null) {
            unawaited(
              cache
                  .saveTimeline(threadId, snapshot, now)
                  .catchError((Object _) {}),
            );
          }
        }
      });
    }

    final online = current != null && widget.online;
    if (online) _latest = current.snapshot;
    final snapshot = _latest;
    final errors = current?.problem ?? selected?.error;
    final synced = online && errors == null && selected?.isLoading == false;
    _reportRunChanges(synced ? connection : null, snapshot);
    _reportPreviewUrls(snapshot);
    if (_synced != synced && widget.onSynced != null) {
      _synced = synced;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _synced == synced) widget.onSynced?.call(synced);
      });
    }
    final retry = provider == null
        ? null
        : () => ref.read(provider.notifier).retry();
    final topInset = MobileChromeInsets.topOf(context);
    final runProvider =
        online && connection != null && connection.supportsRunCommands
        ? runComposerProvider((connection, threadId))
        : null;
    final runState = runProvider == null ? null : ref.watch(runProvider).value;
    final optimistic = _resolveOptimisticMessage(
      runState: runState,
      snapshot: snapshot,
      online: online,
      runProvider: runProvider,
    );
    final Widget timeline;
    if (snapshot != null) {
      timeline = TimelineView(
        snapshot: snapshot,
        online: online,
        topInset: topInset,
        bottomInset: _composerHeight,
        optimisticMessage: optimistic,
        onTapOptimisticFailed: optimistic != null && optimistic.actionable
            ? () => unawaited(
                _handleOptimisticAction(
                  optimistic,
                  online: online,
                  runProvider: runProvider,
                ),
              )
            : null,
        loadEarlier: provider == null
            ? () async {}
            : () => ref.read(provider.notifier).loadEarlier(),
        content: ({seq, runId, toolId, required field, offset}) {
          if (provider == null) throw const ConnectionFailure('offline');
          return ref
              .read(provider.notifier)
              .content(
                seq: seq,
                runId: runId,
                toolId: toolId,
                field: field,
                offset: offset,
              );
        },
        problem: errors == null ? null : _detail(errors),
        retry: retry,
        peekAttachmentThumb: _peekAttachmentThumb,
        loadAttachmentThumb: _loadAttachmentThumb,
        loadAttachmentFull: _loadAttachmentFull,
        onOpenFile:
            online &&
                connection != null &&
                connectionSupportsWorkbenchRead(connection)
            ? (path, {line}) => _openWorkbenchFile(connection, path, line: line)
            : null,
        onOpenLink: (url, title) => unawaited(_handleTimelineLinkTap(url, title)),
        changesCard: online && connection?.supportsRunChanges == true
            ? (turn) => _changes(connection!, turn)
            : null,
        requestCard: online && connection != null
            ? (turn, request) {
                final runId = turn.runId;
                final id = request.itemId;
                final active = connection;
                if (runId == null || id == null) {
                  return TimelineNoticeLine(
                    text: request.kind == MobileTimelineKind.approvalRequested
                        ? '有待处理的审批'
                        : '有待回答的提问',
                  );
                }
                return InlineRequestCard(
                  connection: active,
                  threadId: threadId,
                  runId: runId,
                  requestId: id,
                  online: online,
                );
              }
            : null,
      );
    } else if (!_historyReady || (selected?.isLoading ?? false)) {
      timeline = const Center(child: CircularProgressIndicator.adaptive());
    } else {
      timeline = Center(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(errors == null ? '还没有可离线查看的会话记录。' : _detail(errors)),
              if (retry != null)
                TextButton(onPressed: retry, child: const Text('重试')),
            ],
          ),
        ),
      );
    }
    final input = online && connection != null && snapshot != null
        ? _onlineComposer(connection, snapshot)
        : _draftStore == null
        ? const SizedBox.shrink()
        : _offlineComposer();
    final syncedAt = _syncedAt;
    final reading = widget.reading;
    final shownResult = synced
        ? current.snapshot.events.reversed
              .where(
                (event) => switch (event.kind) {
                  MobileTimelineKind.runCompleted ||
                  MobileTimelineKind.runFailed ||
                  MobileTimelineKind.runInterrupted => true,
                  _ => false,
                },
              )
              .firstOrNull
              ?.runId
        : null;
    final content = LayoutBuilder(
      builder: (context, constraints) => Stack(
        fit: StackFit.expand,
        children: [
          Positioned.fill(
            child: snapshot == null
                ? Padding(
                    padding: EdgeInsets.only(
                      top: topInset,
                      bottom: _composerHeight,
                    ),
                    child: timeline,
                  )
                : timeline,
          ),
          if (snapshot != null && _composerHeight > 0)
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: MobileBottomGlassVeil(height: _composerHeight + 18),
            ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: _MeasureSize(
              onChange: (size) {
                if (!mounted) return;
                if ((_composerHeight - size.height).abs() > 0.5) {
                  setState(() => _composerHeight = size.height);
                }
              },
              child: SafeArea(
                top: false,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (!online && syncedAt != null && snapshot != null)
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 16),
                        child: Text(
                          offlineSyncLabel(syncedAt),
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ),
                    if (_draftError) const Text('暂时无法保存本机草稿。'),
                    ConstrainedBox(
                      constraints: BoxConstraints(
                        maxHeight: constraints.maxHeight * .6,
                      ),
                      child: SingleChildScrollView(child: input),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
    return ThreadReadReceipt(
      visible:
          reading?.visible == true &&
          (ModalRoute.of(context)?.isCurrent ?? true),
      shownRunId: shownResult,
      target: reading?.target,
      manualUnread: reading?.manualUnread,
      connection: connection,
      unread: reading?.unread == true,
      visit: reading?.visit ?? 0,
      confirm: reading != null && connection?.supportsSidebarCommands == true
          ? (target) =>
                connection!.sidebarCommands.acknowledgeRead(threadId, target)
          : null,
      child: content,
    );
  }

  void _reportRunChanges(
    MobileConnection? connection,
    TimelineSnapshot? snapshot,
  ) {
    if (widget.onRunChangesChanged == null) return;
    final events = snapshot?.events;
    if (identical(_changeConnection, connection) &&
        identical(_changeEvents, events)) {
      return;
    }
    _changeConnection = connection;
    _changeEvents = events;
    _RunChangesTarget? target;
    if (connection?.supportsRunChanges == true && events != null) {
      final runEvents = events.reversed.where((event) => event.runId != null);
      final latest =
          runEvents
              .where(
                (event) =>
                    event.kind == MobileTimelineKind.changes ||
                    event.kind == MobileTimelineKind.file,
              )
              .firstOrNull ??
          // 编辑工具完成后也可以向 Host 读取这个 run 的文件清单。
          runEvents
              .where(
                (event) =>
                    event.kind == MobileTimelineKind.toolCompleted &&
                    event.failed != true &&
                    timelineToolKindForName(event.name) ==
                        TimelineToolKind.edit,
              )
              .firstOrNull;
      if (latest != null) {
        target = (
          connection: connection!,
          runId: latest.runId!,
          revision: latest.seq,
        );
      }
    }
    if (_changesTarget == target) return;
    _changesTarget = target;
    _shortcutFiles = null;
    _publishRunChanges(target, null);
    if (target != null) _loadShortcutFiles(target);
  }

  void _publishRunChanges(
    _RunChangesTarget? target,
    MobileRunChangesPage? page,
  ) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _changesTarget != target) return;
      widget.onRunChangesChanged?.call(
        target == null
            ? null
            : (
                fileCount: page?.files.length ?? 0,
                hasMore: page?.nextOffset != null,
                open: _openChanges,
              ),
      );
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  Future<MobileRunChangesPage> _loadShortcutFiles(_RunChangesTarget target) {
    if (_shortcutFiles case final request?) return request;
    final request = _changeLoaders(target.connection, target.runId).files(0);
    _shortcutFiles = request;
    unawaited(
      request.then<void>(
        (page) {
          if (mounted &&
              _changesTarget == target &&
              identical(_shortcutFiles, request)) {
            _publishRunChanges(target, page);
          }
        },
        onError: (Object _) {
          if (identical(_shortcutFiles, request)) _shortcutFiles = null;
        },
      ),
    );
    return request;
  }

  bool get _changesVisible =>
      widget.reading?.visible != false &&
      ModalRoute.of(context)?.isCurrent != false;

  Future<void> _openChanges() async {
    final target = _changesTarget;
    if (!mounted || target == null || _openingChanges || !_changesVisible) {
      return;
    }
    final visit = widget.reading?.visit;
    final loaders = _changeLoaders(target.connection, target.runId);
    _openingChanges = true;
    try {
      final initial = await _loadShortcutFiles(target);
      if (!mounted ||
          _changesTarget != target ||
          widget.reading?.visit != visit ||
          !_changesVisible) {
        return;
      }
      await RunDiffScreen.open(
        context,
        initial: initial,
        loadFiles: loaders.files,
        loadDiff: loaders.diff,
      );
    } catch (_) {
      if (mounted &&
          _changesTarget == target &&
          widget.reading?.visit == visit &&
          _changesVisible) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('暂时无法读取本轮改动。')));
      }
    } finally {
      _openingChanges = false;
    }
  }

  ({RunChangeListLoader files, RunPatchLoader diff}) _changeLoaders(
    MobileConnection connection,
    String runId,
  ) {
    final threadId = widget.threadId;
    return (
      files: (offset) => connection.changes.list(
        MobileRunChangesParams(
          threadId: threadId,
          runId: runId,
          offset: offset,
        ),
      ),
      diff: (path, offset) => connection.changes.diff(
        MobileRunDiffParams(
          threadId: threadId,
          runId: runId,
          path: path,
          offset: offset,
        ),
      ),
    );
  }

  Widget _changes(MobileConnection connection, TimelineTurn turn) {
    final runId = turn.runId;
    if (runId == null) return const SizedBox.shrink();
    final loaders = _changeLoaders(connection, runId);
    return RunChangesCard(
      key: ValueKey((connection, runId)),
      online: true,
      savedPaths: turn.files,
      checkpointRevision: turn.changes?.seq,
      loadFiles: (offset) {
        final target = _changesTarget;
        if (offset == 0 &&
            target?.runId == runId &&
            identical(target?.connection, connection)) {
          return _loadShortcutFiles(target!);
        }
        return loaders.files(offset);
      },
      loadDiff: loaders.diff,
    );
  }

  String? get _effectiveComputerKey =>
      widget.computerKey ?? widget.connection?.computer.computerKey;

  Uint8List? _peekAttachmentThumb(String attachmentId) {
    final key = _effectiveComputerKey;
    if (key == null) return null;
    return ref.read(attachmentCacheProvider).peekThumbMemory(key, attachmentId);
  }

  Future<Uint8List?> _loadAttachmentThumb(String attachmentId) async {
    final cache = ref.read(attachmentCacheProvider);
    final key = _effectiveComputerKey;
    if (key != null) {
      final cached = await cache.readThumb(key, attachmentId);
      if (cached != null) return cached;
    }
    final connection = widget.connection;
    if (!widget.online || !connectionSupportsAttachments(connection)) {
      return null;
    }
    final data = await connection!.readAttachmentThumb(
      attachmentId,
      threadId: widget.threadId,
    );
    if (key != null) {
      unawaited(cache.writeThumb(key, attachmentId, data.bytes));
    }
    return data.bytes;
  }

  Future<Uint8List?> _loadAttachmentFull(String attachmentId) async {
    final cache = ref.read(attachmentCacheProvider);
    final key = _effectiveComputerKey;
    if (key != null) {
      final cached = await cache.readFull(key, attachmentId);
      if (cached != null) return cached;
    }
    final connection = widget.connection;
    if (!widget.online || !connectionSupportsAttachments(connection)) {
      return null;
    }
    final data = await connection!.readAttachmentFull(
      attachmentId,
      threadId: widget.threadId,
    );
    if (key != null) {
      unawaited(cache.writeFull(key, attachmentId, data.bytes));
    }
    return data.bytes;
  }

  Future<void> _pickOfflinePhotos() async {
    final attachments = _attachments;
    if (attachments == null || attachments.remainingSlots <= 0) return;
    try {
      final picked = await ref
          .read(mobileImagePickerProvider)
          .pickFromGallery(limit: attachments.remainingSlots);
      if (!mounted || picked.isEmpty) return;
      await attachments.addLocalFiles([for (final item in picked) item.path]);
    } on PlatformException {
      // 离线场景下忽略未授权异常。
    } catch (_) {}
  }

  Future<void> _takeOfflinePhoto() async {
    final attachments = _attachments;
    if (attachments == null || attachments.remainingSlots <= 0) return;
    try {
      final picked = await ref
          .read(mobileImagePickerProvider)
          .captureFromCamera();
      if (!mounted || picked == null) return;
      await attachments.addLocalFiles([picked.path]);
    } on PlatformException {
      // 离线场景下忽略未授权异常。
    } catch (_) {}
  }

  Widget _offlineComposer() {
    if (!_draftReady) return const SizedBox.shrink();
    final attachments = _attachments;
    final canStageOffline =
        attachments != null &&
        (_rememberedAttachmentsSupport ||
            connectionSupportsAttachments(widget.connection));
    if (attachments == null) {
      return RunComposerView(
        draft: _text,
        online: false,
        state: null,
        storageError: false,
        glass: true,
        onRetryLoad: () {},
        onSend: (_) {},
        onStop: (_) {},
        onCheck: (_) {},
        onRetry: (_) {},
      );
    }
    return ListenableBuilder(
      listenable: attachments,
      builder: (context, _) => RunComposerView(
        draft: _text,
        online: false,
        state: null,
        storageError: false,
        glass: true,
        onRetryLoad: () {},
        onSend: (_) {},
        onStop: (_) {},
        onCheck: (_) {},
        onRetry: (_) {},
        attachments: attachments,
        loadRemoteFull: _loadAttachmentFull,
        leading: canStageOffline
            ? MobileComposerAttachButton(
                offline: true,
                showMentions: false,
                showAttachments: true,
                attachmentCount: attachments.count,
                onSelectTrigger: (_) {},
                onPickPhotos: () => unawaited(_pickOfflinePhotos()),
                onTakePhoto: () => unawaited(_takeOfflinePhoto()),
              )
            : null,
      ),
    );
  }

  Widget _onlineComposer(
    MobileConnection connection,
    TimelineSnapshot snapshot,
  ) {
    if (!_draftReady) return const SizedBox.shrink();
    final threadId = widget.threadId;
    final runId = _stoppableRun(snapshot);
    final Widget composer;
    if (!connection.supportsRunCommands) {
      composer = _offlineComposer();
    } else {
      final revision =
          snapshot.events.reversed
              .where(
                (event) => const {
                  MobileTimelineKind.queueChanged,
                  MobileTimelineKind.runQueued,
                  MobileTimelineKind.runStarted,
                  MobileTimelineKind.runCompleted,
                  MobileTimelineKind.runFailed,
                  MobileTimelineKind.runInterrupted,
                }.contains(event.kind),
              )
              .firstOrNull
              ?.seq ??
          0;
      composer = RunComposer(
        connection: connection,
        threadId: threadId,
        projectId: widget.projectId,
        projects: widget.projects,
        threads: widget.threads,
        online: true,
        draft: _text,
        attachments: _attachments,
        supportsAttachments:
            _rememberedAttachmentsSupport ||
            connectionSupportsAttachments(connection),
        stoppableRunId: runId,
        queueRevision: revision,
        composer: snapshot.composer,
        optimisticBubbles: true,
        glass: true,
        onSendReserved: (saved, refs) {
          if (refs.isNotEmpty) {
            _optimisticAttachments[saved.commandId] = refs;
          }
          _lastUnconfirmedSend = saved;
        },
        wrapInput: (input) => input,
      );
    }
    final waiting =
        connection.supportsRequestCommands &&
        (snapshot.live?.pending.isNotEmpty ?? false);
    if (!waiting) return composer;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(12, 4, 12, 4),
          child: TimelineNoticeLine(
            text: '上方有等待处理的审批或回答，处理后会自动恢复。',
            level: TimelineNoticeLevel.info,
          ),
        ),
        composer,
      ],
    );
  }

  String? _stoppableRun(TimelineSnapshot snapshot) {
    if (snapshot.live case final live?) return live.runId;
    for (final event in snapshot.events.reversed) {
      switch (event.kind) {
        case MobileTimelineKind.runQueued:
        case MobileTimelineKind.runStarted:
          return event.runId;
        case MobileTimelineKind.runCompleted:
        case MobileTimelineKind.runFailed:
        case MobileTimelineKind.runInterrupted:
          return null;
        default:
          break;
      }
    }
    return null;
  }

  Future<void> _openWorkbenchFile(
    MobileConnection connection,
    String rawPath, {
    int? line,
  }) async {
    if (!mounted) return;
    final parsed = parseFileReference(rawPath);
    final path = parsed.path;
    final targetLine = line ?? parsed.line;
    if (path.isEmpty) return;
    if (path.length > mobileWorkbenchPathMax) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('文件路径过长，暂不支持预览。')),
      );
      return;
    }
    if (path.endsWith('/')) {
      final dir = path.substring(0, path.length - 1);
      final supportsPreview = connectionSupportsPreviewTunnel(connection);
      await MobileWorkbenchScreen.open(
        context,
        connection: connection,
        threadId: widget.threadId,
        initialTab: MobileWorkbenchTab.files,
        initialDirectory: dir,
        openExternalUrl: widget.openExternalUrl,
        previewTabBuilder: supportsPreview
            ? (_) => PreviewTab(
                  connection: connection,
                  threadId: widget.threadId,
                  computerKey: _effectiveComputerKey,
                  timelineUrls: extractPreviewUrlsFromSnapshot(_latest),
                  timelineUrlsProvider: () =>
                      extractPreviewUrlsFromSnapshot(_latest),
                  openExternalUrl: widget.openExternalUrl,
                  webViewBuilder: widget.previewWebViewBuilder,
                )
            : null,
      );
      return;
    }
    await MobileFileViewerScreen.open(
      context,
      connection: connection,
      threadId: widget.threadId,
      path: path,
      initialLine: targetLine,
    );
  }

  void _reportPreviewUrls(TimelineSnapshot? snapshot) {
    final callback = widget.onPreviewUrlsChanged;
    if (callback == null) return;
    final events = snapshot?.events;
    final live = snapshot?.live;
    if (identical(_previewSourceEvents, events) &&
        identical(_previewSourceLive, live)) {
      return;
    }
    _previewSourceEvents = events;
    _previewSourceLive = live;
    final next = extractPreviewUrlsFromSnapshot(snapshot);
    if (_stringListEquals(_reportedPreviewUrls, next)) return;
    _reportedPreviewUrls = next;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && identical(_reportedPreviewUrls, next)) {
        callback(next);
      }
    });
  }

  bool _stringListEquals(List<String> a, List<String> b) {
    if (identical(a, b)) return true;
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }

  Future<void> _handleTimelineLinkTap(String rawUrl, String title) async {
    if (!mounted) return;
    final trimmed = rawUrl.trim();
    if (trimmed.isEmpty) return;

    if (isLocalhostPreviewUrl(trimmed)) {
      final connection = widget.connection;
      if (!widget.online || connection == null) {
        ScaffoldMessenger.maybeOf(context)
          ?..hideCurrentSnackBar()
          ..showSnackBar(
            const SnackBar(content: Text('电脑当前离线，连接后再打开本机预览')),
          );
        return;
      }
      if (!connectionSupportsPreviewTunnel(connection)) {
        ScaffoldMessenger.maybeOf(context)
          ?..hideCurrentSnackBar()
          ..showSnackBar(
            const SnackBar(content: Text('请更新电脑上的 Pigcode 后使用本机预览')),
          );
        return;
      }
      final uri = normalizePreviewInput(trimmed).uri;
      if (uri != null) {
        await MobilePreviewWebViewScreen.open(
          context,
          connection: connection,
          initialUrl: uri,
          computerKey: _effectiveComputerKey,
          openExternalUrl: widget.openExternalUrl,
          webViewBuilder: widget.previewWebViewBuilder,
        );
      }
      return;
    }

    final uri = Uri.tryParse(trimmed);
    if (uri != null &&
        (uri.scheme.toLowerCase() == 'http' ||
            uri.scheme.toLowerCase() == 'https')) {
      await confirmAndOpenExternalUrl(
        context,
        uri,
        openExternalUrl: widget.openExternalUrl,
      );
      return;
    }

    await Clipboard.setData(ClipboardData(text: trimmed));
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(
      context,
    )?.showSnackBar(SnackBar(content: Text('已复制链接 $trimmed')));
  }

  String _detail(Object error) => switch (error) {
    MobileRpcFailure(:final problem) => problem.message,
    ConnectionFailure(code: 'update-desktop') => '请更新电脑上的 Pigcode 后查看时间线。',
    _ => '暂时无法读取这条会话。',
  };

  OptimisticUserMessage? _resolveOptimisticMessage({
    required RunComposerState? runState,
    required TimelineSnapshot? snapshot,
    required bool online,
    required AsyncNotifierProvider<RunComposerController, RunComposerState>?
    runProvider,
  }) {
    const method = MobileRunMethod.runStart;
    if (runState != null) {
      final pending = runState.pending[method];
      if (pending is PendingSend) {
        _lastUnconfirmedSend = pending;
        final working = runState.working.contains(method);
        return OptimisticUserMessage(
          commandId: pending.commandId,
          text: pending.params.text,
          status: working
              ? OptimisticMessageStatus.sending
              : OptimisticMessageStatus.unconfirmed,
          attachments: _attachmentsForCommand(pending),
          params: pending.params,
        );
      }
      final outcome = runState.outcomes[method];
      if (outcome != null && outcome.command is PendingSend) {
        final send = outcome.command as PendingSend;
        if (outcome.receipt case final receipt?) {
          _lastUnconfirmedSend = null;
          final alreadyInTimeline =
              receipt.queuedMessageId != null ||
              (snapshot != null &&
                  snapshot.events.any(
                    (event) =>
                        event.kind == MobileTimelineKind.messageUser &&
                        event.runId == receipt.runId,
                  ));
          if (alreadyInTimeline) {
            if (runProvider != null) {
              WidgetsBinding.instance.addPostFrameCallback((_) {
                if (mounted) {
                  ref.read(runProvider.notifier).clearOutcome(method);
                }
              });
            }
            return null;
          }
          return OptimisticUserMessage(
            commandId: send.commandId,
            text: send.params.text,
            status: OptimisticMessageStatus.accepted,
            attachments: _attachmentsForCommand(send),
            runId: receipt.runId,
            queuedMessageId: receipt.queuedMessageId,
            params: send.params,
          );
        }
        _lastUnconfirmedSend = null;
        return OptimisticUserMessage(
          commandId: send.commandId,
          text: send.params.text,
          status: OptimisticMessageStatus.rejected,
          attachments: _attachmentsForCommand(send),
          errorText: runState.notices[method],
          params: send.params,
        );
      }
      // 联机状态已无 pending/outcome，说明该条已经结算。
      _lastUnconfirmedSend = null;
      return null;
    }

    if (!online) {
      final offlinePending = _lastUnconfirmedSend;
      if (offlinePending != null) {
        return OptimisticUserMessage(
          commandId: offlinePending.commandId,
          text: offlinePending.params.text,
          status: OptimisticMessageStatus.unconfirmed,
          attachments: _attachmentsForCommand(offlinePending),
          params: offlinePending.params,
        );
      }
    }
    return null;
  }

  List<MobileAttachmentRef> _attachmentsForCommand(PendingSend send) {
    final cached = _optimisticAttachments[send.commandId];
    if (cached != null) return cached;
    final ids = send.params.attachmentIds;
    if (ids == null || ids.isEmpty) return const [];
    return [
      for (final id in ids)
        MobileAttachmentRef(
          id: id,
          fileName: '图片',
          mimeType: 'image/jpeg',
          sizeBytes: 0,
        ),
    ];
  }

  Future<void> _handleOptimisticAction(
    OptimisticUserMessage message, {
    required bool online,
    required AsyncNotifierProvider<RunComposerController, RunComposerState>?
    runProvider,
  }) async {
    const method = MobileRunMethod.runStart;
    final controller = runProvider == null ? null : ref.read(runProvider.notifier);
    await showOptimisticMessageActionsSheet(
      context,
      message: message,
      online: online,
      onResend: controller == null
          ? null
          : () {
              if (message.status == OptimisticMessageStatus.rejected) {
                final params = message.params;
                if (params == null) return;
                controller.clearOutcome(method);
                unawaited(
                  controller.send(
                    params.text,
                    effort: params.effort,
                    fast: params.fast,
                    ultracode: params.ultracode,
                    references: params.references,
                    attachmentIds: params.attachmentIds,
                    clearDraftImmediately: true,
                    onReserved: (saved) {
                      if (message.attachments.isNotEmpty) {
                        _optimisticAttachments[saved.commandId] =
                            message.attachments;
                      }
                      _lastUnconfirmedSend = saved;
                    },
                  ),
                );
              } else {
                unawaited(controller.retry(method));
              }
            },
      onCheckReceipt: controller == null
          ? null
          : () => unawaited(controller.check(method)),
      onRestoreToInput: () {
        final current = _text.text;
        final next = current.trim().isEmpty
            ? message.text
            : '$current\n${message.text}';
        _text.value = TextEditingValue(
          text: next,
          selection: TextSelection.collapsed(offset: next.length),
        );
        if (controller != null) {
          unawaited(controller.discard(method));
        }
        setState(() => _lastUnconfirmedSend = null);
      },
      onDelete: () {
        if (controller != null) {
          unawaited(controller.discard(method));
        }
        setState(() => _lastUnconfirmedSend = null);
      },
    );
  }
}

class _MeasureSize extends StatefulWidget {
  const _MeasureSize({required this.onChange, required this.child});

  final ValueChanged<Size> onChange;
  final Widget child;

  @override
  State<_MeasureSize> createState() => _MeasureSizeState();
}

class _MeasureSizeState extends State<_MeasureSize> {
  Size? _lastSize;

  @override
  Widget build(BuildContext context) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final box = context.findRenderObject();
      if (box is! RenderBox || !box.hasSize) return;
      final size = box.size;
      if (_lastSize != size) {
        _lastSize = size;
        widget.onChange(size);
      }
    });
    return widget.child;
  }
}
