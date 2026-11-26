import 'dart:async';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart' show setEquals, visibleForTesting;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

import 'app_theme.dart';
import 'attachments/attachment_cache.dart';
import 'attachments/composer_attachments_controller.dart';
import 'attachments/image_compressor.dart';
import 'computer_reconnect.dart';
import 'computers.dart';
import 'local_drafts.dart';
import 'mobile_glass.dart';
import 'new_thread_draft_state.dart';
import 'offline_cache.dart';
import 'mobile_reminders.dart';
import 'reminder_settings_page.dart';
import 'share/share_receiver.dart';
import 'share/share_target_sheet.dart';
import 'theme_colors.dart';
import 'workspace.dart';

typedef ComputerReconnectFactory =
    ComputerReconnect Function(
      ComputerProfile computer,
      NoiseIdentity identity,
      VoidCallback onChange,
    );

final computerReconnectFactoryProvider = Provider<ComputerReconnectFactory>(
  (_) =>
      (computer, identity, onChange) => ComputerReconnect(
        dial: () => MobileConnection.resume(computer, identity),
        observe: () => RelayStatusWatch.open(computer),
        onChange: onChange,
      ),
);

const _routableTransports = {
  ConnectivityResult.wifi,
  ConnectivityResult.mobile,
  ConnectivityResult.ethernet,
  ConnectivityResult.vpn,
  ConnectivityResult.other,
};

@visibleForTesting
bool shouldReconnectForNetworkChange(
  Set<ConnectivityResult> previous,
  Set<ConnectivityResult> next,
) => !setEquals(
  previous.intersection(_routableTransports),
  next.intersection(_routableTransports),
);

const _version = String.fromEnvironment('PIGCODE_PRODUCT_VERSION');

void main() {
  runApp(const ProviderScope(child: PigcodeApp()));
}

class PigcodeApp extends StatelessWidget {
  const PigcodeApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Pigcode',
    debugShowCheckedModeBanner: false,
    theme: pigcodeTheme(Brightness.light),
    darkTheme: pigcodeTheme(Brightness.dark),
    home: const ComputersPage(),
  );
}

class ComputersPage extends ConsumerStatefulWidget {
  const ComputersPage({super.key});

  @override
  ConsumerState<ComputersPage> createState() => _ComputersPageState();
}

class _ComputersPageState extends ConsumerState<ComputersPage>
    with WidgetsBindingObserver {
  ComputerReconnect? _session;
  StreamSubscription<List<ConnectivityResult>>? _networks;
  Set<ConnectivityResult>? _network;
  late bool _foreground;
  ComputerOfflineCache? _cache;
  bool _workspaceOpen = false;
  String? _selected;
  String? _verification;
  String? _feedback;
  bool _working = false;
  bool _updatingRelay = false;
  late final MobileReminderBridge _reminders;
  MobileReminder? _queuedReminder;
  MobileReminder? _openReminder;
  bool _openingReminder = false;
  final _openedReminders = <(String, String)>{};
  String? _computerId;
  String? _visibleThreadId;
  SidebarSnapshot? _activeSidebar;
  String? _activeThreadId;
  bool _activeDraftOpen = false;
  ShareNavigationRequest? _openShareTarget;
  LiveShareInjection? _liveShare;
  bool _shareSheetOpen = false;
  bool _stagingShare = false;
  String? _shareSelectedComputerKey;
  final _shareSheetRevision = ValueNotifier<int>(0);
  final _cachedSidebars = <String, SidebarSnapshot?>{};
  final _loadingCachedSidebars = <String>{};
  final _reminderSettings = ValueNotifier<MobileReminderSettings?>(null);
  (MobileConnection, bool, MobileReminderPermission, String?)? _sentSettings;

  @override
  void initState() {
    super.initState();
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    _foreground =
        lifecycle == null ||
        lifecycle == AppLifecycleState.resumed ||
        lifecycle == AppLifecycleState.inactive;
    _reminders = ref.read(mobileReminderBridgeProvider);
    _reminders.watch(
      onTap: () => unawaited(_readReminderTap()),
      onSettingsChanged: () => unawaited(_refreshReminderSettings()),
    );
    unawaited(_readReminderTap());
    unawaited(_refreshReminderSettings());
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (ref.read(shareReceiverProvider) != null) {
        _scheduleShareSheet();
      }
    });
    WidgetsBinding.instance.addObserver(this);
    final connectivity = Connectivity();
    _networks = connectivity.onConnectivityChanged.listen((networks) {
      final next = networks.toSet();
      final previous = _network;
      _network = next;
      if (previous == null ||
          !shouldReconnectForNetworkChange(previous, next)) {
        return;
      }
      // Wi-Fi / 蜂窝 / VPN 切换后，iOS 上的旧 TCP 连接会长时间半开假在线；
      // 直接切到新代并立即用新网络重连，避免发消息卡死在旧 socket。
      _session?.retry();
    }, onError: (Object _) {});
    unawaited(
      connectivity.checkConnectivity().then<void>((networks) {
        if (mounted) _network ??= networks.toSet();
      }, onError: (Object _) {}),
    );
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.inactive) return;
    _foreground = state == AppLifecycleState.resumed;
    _session?.setForeground(_foreground);
    _syncVisibleThread();
    if (_foreground) {
      unawaited(_readReminderTap());
      unawaited(_openQueuedReminder());
      unawaited(_refreshReminderSettings());
      unawaited(ref.read(shareReceiverProvider.notifier).checkPending());
    }
  }

  Future<void> _readReminderTap() async {
    final reminder = await _reminders.takeTap();
    if (!mounted ||
        reminder == null ||
        !_openedReminders.add((reminder.computerId, reminder.eventId))) {
      return;
    }
    if (_openedReminders.length > 128) {
      _openedReminders.remove(_openedReminders.first);
    }
    _queuedReminder = reminder;
    await _openQueuedReminder();
  }

  Future<void> _openQueuedReminder() async {
    if (!mounted ||
        _openingReminder ||
        _working ||
        !_foreground ||
        _queuedReminder == null) {
      return;
    }
    _openingReminder = true;
    try {
      while (mounted && !_working && _foreground && _queuedReminder != null) {
        final reminder = _queuedReminder!;
        final computers = await ref.read(computersProvider.future);
        final computer = await findReminderComputer(reminder, computers);
        if (!mounted || _working || !_foreground) return;
        if (!identical(reminder, _queuedReminder)) continue;
        _queuedReminder = null;
        Navigator.of(context).popUntil((route) => route.isFirst);
        if (computer == null) {
          _showWorkspace(false);
          setState(() => _feedback = '这条通知对应的电脑已不在配对列表中。');
        } else if (_selected == computer.computerKey) {
          setState(() {
            if (_visibleThreadId != reminder.threadId) _visibleThreadId = null;
            _openReminder = reminder;
          });
          _showWorkspace(true);
          final session = _session;
          if (session != null &&
              session.connection == null &&
              !session.connecting) {
            session.retry();
          }
        } else {
          _select(computer, reminder: reminder);
        }
      }
    } catch (_) {
      if (mounted) setState(() => _feedback = '暂时无法打开通知里的会话。');
    } finally {
      _openingReminder = false;
    }
  }

  Future<void> _refreshReminderSettings() async {
    try {
      final settings = await _reminders.settings();
      if (mounted) _reminderSettingsChanged(settings);
    } catch (_) {
      // The phone settings page offers a retry.
    }
  }

  void _reminderSettingsChanged(MobileReminderSettings settings) {
    _reminderSettings.value = settings;
    _reportReminderSettings();
  }

  void _reportReminderSettings() {
    final connection = _session?.connection;
    final settings = _reminderSettings.value;
    if (connection == null || settings == null) return;
    final report = (
      connection,
      settings.enabled,
      settings.permission,
      settings.apns?.observationId,
    );
    if (_sentSettings == report) return;
    _sentSettings = report;
    unawaited(
      connection.reportReminderSettings(settings).catchError((Object _) {
        if (_sentSettings == report) _sentSettings = null;
      }),
    );
  }

  void _syncVisibleThread() {
    final visible = _foreground && _workspaceOpen;
    unawaited(
      _reminders
          .setVisible(
            visible ? _computerId : null,
            visible ? _visibleThreadId : null,
          )
          .catchError((Object _) {}),
    );
  }

  void _showWorkspace(bool open) {
    setState(() => _workspaceOpen = open);
    _syncVisibleThread();
  }

  void _notifyShareSheet() {
    if (mounted) _shareSheetRevision.value++;
  }

  void _ensureCachedSidebar(String computerKey) {
    if (_cachedSidebars.containsKey(computerKey) ||
        !_loadingCachedSidebars.add(computerKey)) {
      return;
    }
    _notifyShareSheet();
    final cache = ref.read(offlineCacheProvider).open(computerKey);
    unawaited(
      cache.readSidebar().catchError((Object _) => null).then((snapshot) {
        if (!mounted) return;
        _loadingCachedSidebars.remove(computerKey);
        _cachedSidebars[computerKey] = snapshot;
        _notifyShareSheet();
      }),
    );
  }

  void _scheduleShareSheet() {
    if (_shareSheetOpen || !mounted) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _shareSheetOpen) return;
      if (ref.read(shareReceiverProvider) != null) {
        unawaited(_presentShareSheet());
      }
    });
  }

  Future<void> _presentShareSheet() async {
    if (_shareSheetOpen || !mounted) return;
    _shareSheetOpen = true;
    final computers = ref.read(computersProvider).value ?? const [];
    _shareSelectedComputerKey = _selected ?? computers.firstOrNull?.computerKey;
    if (_shareSelectedComputerKey case final key?) {
      _ensureCachedSidebar(key);
      if (_selected == null) {
        final target = computers
            .where((entry) => entry.computerKey == key)
            .firstOrNull;
        if (target != null) {
          _select(target, openWorkspace: false);
        }
      }
    }
    final palette = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    var openPairingAfterClose = false;
    try {
      await showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        useSafeArea: true,
        backgroundColor: Colors.transparent,
        barrierColor: palette.scrim,
        barrierLabel: '关闭',
        elevation: 0,
        builder: (sheetContext) => _ShareSheetModal(
          revision: _shareSheetRevision,
          busy: () => _stagingShare,
          resolveSelectedKey: (entries) {
            final chosen = _shareSelectedComputerKey;
            if (chosen != null &&
                entries.any((entry) => entry.computerKey == chosen)) {
              return chosen;
            }
            if (_selected != null &&
                entries.any((entry) => entry.computerKey == _selected)) {
              return _selected;
            }
            return entries.firstOrNull?.computerKey;
          },
          buildComputerInfo: (computer) {
            final key = computer.computerKey;
            if (key == _selected) {
              final conn = _session?.connection;
              final snapshot = _activeSidebar ?? _cachedSidebars[key];
              if (snapshot == null) _ensureCachedSidebar(key);
              return ShareComputerTargetInfo(
                computer: computer,
                connected: conn != null,
                supportsAttachments: conn == null
                    ? null
                    : connectionSupportsAttachments(conn),
                snapshot: snapshot,
                activeThreadId: _activeDraftOpen ? null : _activeThreadId,
                loading: _loadingCachedSidebars.contains(key),
              );
            }
            _ensureCachedSidebar(key);
            return ShareComputerTargetInfo(
              computer: computer,
              connected: false,
              supportsAttachments: null,
              snapshot: _cachedSidebars[key],
              activeThreadId: null,
              loading: _loadingCachedSidebars.contains(key),
            );
          },
          onSelectComputer: (computer) {
            _shareSelectedComputerKey = computer.computerKey;
            _ensureCachedSidebar(computer.computerKey);
            if (_selected != computer.computerKey) {
              _select(computer, openWorkspace: _workspaceOpen);
            }
            _notifyShareSheet();
          },
          onSelectTarget: (batch, selection) =>
              unawaited(_handleShareTarget(sheetContext, batch, selection)),
          onPair: () {
            openPairingAfterClose = true;
            unawaited(ref.read(shareReceiverProvider.notifier).dismiss());
            Navigator.of(sheetContext).pop();
          },
          onClose: () => Navigator.of(sheetContext).pop(),
        ),
      );
    } finally {
      _shareSheetOpen = false;
      _stagingShare = false;
      if (mounted && ref.read(shareReceiverProvider) != null) {
        unawaited(ref.read(shareReceiverProvider.notifier).dismiss());
      }
    }
    if (openPairingAfterClose && mounted) {
      _showWorkspace(false);
      unawaited(_scan());
    }
  }

  Future<void> _handleShareTarget(
    BuildContext sheetContext,
    IncomingShareBatch batch,
    ShareTargetSelection selection,
  ) async {
    if (_stagingShare) return;
    _stagingShare = true;
    _notifyShareSheet();
    String? overflowNotice;
    try {
      final isLiveExisting =
          !selection.isNewThread &&
          _selected == selection.computerKey &&
          !_activeDraftOpen &&
          _activeThreadId == selection.threadId;
      final isLiveDraft =
          selection.isNewThread &&
          _selected == selection.computerKey &&
          _activeDraftOpen;

      if (isLiveExisting || isLiveDraft) {
        final injection = LiveShareInjection(
          id: batch.batchId,
          paths: batch.paths,
          threadId: selection.threadId,
          forNewThread: selection.isNewThread,
        );
        if (mounted) {
          setState(() {
            _liveShare = injection;
            _workspaceOpen = true;
          });
          _syncVisibleThread();
        }
        await injection.done.future.timeout(
          const Duration(seconds: 15),
          onTimeout: () {},
        );
        await ref
            .read(shareReceiverProvider.notifier)
            .completeBatch(batch.batchId);
      } else {
        final cache = ref.read(attachmentCacheProvider);
        final compressor = ref.read(imageCompressorProvider);
        if (selection.isNewThread) {
          final deviceId = ref.read(computersProvider.notifier).deviceId;
          final store = NewThreadDraftStorage(
            selection.computerKey,
            deviceId,
            attachmentCache: cache,
          );
          final form = await store.readForm();
          final staged = await stageSharedImagesToDraft(
            computerKey: selection.computerKey,
            paths: batch.paths,
            cache: cache,
            compressor: compressor,
            existingCount: form.attachments.length,
          );
          if (staged.records.isNotEmpty) {
            await store.appendAttachments(staged.records);
          }
          overflowNotice = staged.error;
        } else {
          final store = ThreadDraftStorage(
            selection.computerKey,
            selection.threadId!,
            attachmentCache: cache,
          );
          final existing = await store.readFull();
          final staged = await stageSharedImagesToDraft(
            computerKey: selection.computerKey,
            paths: batch.paths,
            cache: cache,
            compressor: compressor,
            existingCount: existing.attachments.length,
          );
          if (staged.records.isNotEmpty) {
            await store.appendAttachments(staged.records);
          }
          overflowNotice = staged.error;
        }

        await ref
            .read(shareReceiverProvider.notifier)
            .completeBatch(batch.batchId);

        if (mounted) {
          final nav = ShareNavigationRequest(
            id: batch.batchId,
            threadId: selection.threadId,
            openDraft: selection.isNewThread,
          );
          if (_selected != selection.computerKey) {
            final entries = ref.read(computersProvider).value ?? const [];
            final profile = entries
                .where((entry) => entry.computerKey == selection.computerKey)
                .firstOrNull;
            if (profile != null) {
              _select(profile, shareTarget: nav, openWorkspace: true);
            }
          } else {
            setState(() {
              _openShareTarget = nav;
              _workspaceOpen = true;
            });
            _syncVisibleThread();
          }
        }
      }
    } catch (_) {
      overflowNotice ??= '暂时无法处理分享的图片，请重试。';
      await ref
          .read(shareReceiverProvider.notifier)
          .completeBatch(batch.batchId);
    } finally {
      _stagingShare = false;
      _notifyShareSheet();
      if (sheetContext.mounted && Navigator.of(sheetContext).canPop()) {
        Navigator.of(sheetContext).pop();
      }
    }
    if (overflowNotice != null && overflowNotice.isNotEmpty && mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(overflowNotice)));
    }
  }

  void _select(
    ComputerProfile computer, {
    MobileConnection? initial,
    MobileReminder? reminder,
    ShareNavigationRequest? shareTarget,
    bool openWorkspace = true,
  }) {
    final identity = ref.read(computersProvider.notifier).identity;
    final createReconnect = ref.read(computerReconnectFactoryProvider);
    late final ComputerReconnect session;
    session = createReconnect(computer, identity, () {
      if (!mounted || !identical(_session, session)) return;
      if (session.error == 'device-revoked') {
        unawaited(_confirmedRevocation(computer));
      } else {
        setState(() {});
        _reportReminderSettings();
        _notifyShareSheet();
      }
    });
    _session?.dispose();
    setState(() {
      _session = session;
      _selected = computer.computerKey;
      _cache = ref.read(offlineCacheProvider).open(computer.computerKey);
      _openReminder = reminder;
      _openShareTarget = shareTarget;
      _liveShare = null;
      _activeSidebar = _cachedSidebars[computer.computerKey];
      _activeThreadId = shareTarget?.openDraft == true
          ? null
          : shareTarget?.threadId;
      _activeDraftOpen = shareTarget?.openDraft ?? false;
      _computerId = null;
      _visibleThreadId = null;
      _workspaceOpen = openWorkspace;
      _feedback = null;
    });
    _syncVisibleThread();
    _notifyShareSheet();
    unawaited(
      reminderComputerId(computer).then((id) {
        if (!mounted || !identical(_session, session)) return;
        _computerId = id;
        _syncVisibleThread();
      }),
    );
    session.start(foreground: _foreground, initial: initial);
  }

  Future<void> _choose(
    ComputerProfile computer, {
    PairingInvite? invite,
  }) async {
    if (_working) return;
    if (invite == null) {
      if (_selected == computer.computerKey) {
        _showWorkspace(true);
        if (_session?.connection == null) _session?.retry();
      } else {
        _select(computer);
      }
      return;
    }

    final existing = ref
        .read(computersProvider)
        .requireValue
        .where((entry) => entry.computerKey == computer.computerKey)
        .firstOrNull;
    _session?.dispose();
    setState(() {
      _session = null;
      _working = true;
      _workspaceOpen = false;
      _cache = null;
      _openReminder = null;
      _computerId = null;
      _visibleThreadId = null;
      _updatingRelay = existing != null;
      _verification = null;
      _feedback = null;
      _selected = null;
    });
    _syncVisibleThread();

    MobileConnection? opened;
    try {
      final computers = ref.read(computersProvider.notifier);
      void showCode(String code) {
        if (mounted) setState(() => _verification = code);
      }

      opened = existing == null
          ? await MobileConnection.pair(
              invite: invite,
              identity: computers.identity,
              deviceName: Platform.isIOS ? 'iPhone' : 'Android 手机',
              platform: Platform.isIOS ? 'ios' : 'android',
              showVerificationCode: showCode,
            )
          : await MobileConnection.updateRelay(
              computer: existing,
              invite: invite,
              identity: computers.identity,
              showVerificationCode: showCode,
            );
      if (!mounted) return;
      await computers.remember(opened.computer);
      await opened.announceRelaySaved();
      if (!mounted) return;
      _select(opened.computer, initial: opened);
      opened = null;
      if (existing != null) setState(() => _feedback = '已更新这台电脑的中继配置。');
    } on ConnectionFailure catch (failure) {
      if (mounted) {
        setState(() {
          _feedback =
              existing != null &&
                  const {
                    'authentication-failed',
                    'closed',
                  }.contains(failure.code)
              ? '未能确认原配对。若已在电脑撤销，请移除这台电脑再扫码配对。'
              : _message(failure.code);
        });
      }
    } catch (_) {
      if (mounted) setState(() => _feedback = '无法完成连接，请重试。');
    } finally {
      await opened?.close();
      if (mounted) {
        setState(() {
          _working = false;
          _verification = null;
        });
        unawaited(_openQueuedReminder());
      }
    }
  }

  Future<void> _confirmedRevocation(ComputerProfile computer) async {
    final computers = ref.read(computersProvider.notifier);
    Navigator.of(context).popUntil((route) => route.isFirst);
    _leaveComputer();
    setState(() {
      _working = true;
      _feedback = '电脑已撤销本机配对，请重新扫码。';
    });
    try {
      if (!await computers.forget(computer) && mounted) {
        setState(() => _feedback = '电脑已撤销配对，本机暂时无法清理全部记录。');
      }
    } catch (_) {
      if (mounted) setState(() => _feedback = '电脑已撤销配对，本机暂时无法移除这台电脑。');
    } finally {
      if (mounted) {
        setState(() => _working = false);
        unawaited(_openQueuedReminder());
      }
    }
  }

  void _leaveComputer() {
    _session?.dispose();
    setState(() {
      _session = null;
      _selected = null;
      _cache = null;
      _openReminder = null;
      _openShareTarget = null;
      _liveShare = null;
      _activeSidebar = null;
      _activeThreadId = null;
      _activeDraftOpen = false;
      _computerId = null;
      _visibleThreadId = null;
      _workspaceOpen = false;
    });
    _syncVisibleThread();
    _notifyShareSheet();
  }

  String _connectionLabel(BuildContext context) {
    final session = _session;
    if (session == null) return '连接已断开';
    if (session.connection != null) return '已连接';
    final status = session.status;
    final failure = session.error;
    final String label;
    if (failure != null && !const {'closed', 'offline'}.contains(failure)) {
      label = _message(failure);
    } else {
      label = switch (status?.state) {
        RelayComputerState.online => '正在连接电脑…',
        RelayComputerState.sleeping => '电脑正在睡眠',
        RelayComputerState.exited => '电脑上的 Pigcode 已退出',
        RelayComputerState.restarting => '电脑上的 Pigcode 正在重启',
        RelayComputerState.offline => '电脑离线',
        _ when failure == 'offline' => '电脑离线',
        _ => session.connecting || failure == null ? '正在连接电脑…' : '正在重新连接电脑…',
      };
    }
    final seen = status?.lastOnlineAt?.toLocal();
    if (seen == null) return label;
    final format = MaterialLocalizations.of(context);
    final time = format.formatTimeOfDay(TimeOfDay.fromDateTime(seen));
    final stamp = DateUtils.isSameDay(seen, DateTime.now())
        ? time
        : '${format.formatShortDate(seen)} $time';
    return '$label · 最后在线 $stamp';
  }

  String _message(String code) => switch (code) {
    'expired' => '二维码已过期，请在电脑重新生成。',
    'offline' => '这台电脑未连接中继。',
    'unreachable' => '连不上中继，请检查网络。',
    'token-rejected' => '中继拒绝了访问令牌，请重新扫码。',
    'update-phone' => '请更新 Pigcode 手机端后重新连接。',
    'update-desktop' => '请更新这台电脑上的 Pigcode 后重新连接。',
    'incompatible' => '连接协议不兼容，请检查两端和中继的版本。',
    'busy' => '电脑的手机连接已满，请稍后重试。',
    'computer-key-changed' => '这个二维码对应另一台电脑。',
    'authentication-failed' => '电脑或设备身份验证失败，请检查配对。',
    _ => '连接已关闭。请确认电脑上的配对未取消。',
  };

  Future<void> _scan() async {
    final qr = await Navigator.of(
      context,
    ).push<String>(MaterialPageRoute(builder: (_) => const ScanPage()));
    if (!mounted || qr == null) return;
    try {
      final invite = PairingInvite.parse(qr);
      await _choose(invite.computer, invite: invite);
    } on ConnectionFailure catch (failure) {
      setState(() => _feedback = _message(failure.code));
    } catch (_) {
      setState(() => _feedback = '这个二维码无法用于 Pigcode 配对。');
    }
  }

  Future<void> _forget(ComputerProfile computer) async {
    final accepted = await showDialog<bool>(
      context: context,
      builder: (dialog) {
        final navigator = Navigator.of(dialog);
        final palette = Theme.of(dialog).brightness == Brightness.dark
            ? pigcodeDark
            : pigcodeLight;
        return MobileGlassDialog(
          title: Text('移除「${computer.name}」'),
          content: const Text('移除手机上保存的连接配置。再次连接时需要扫码配对。'),
          actions: [
            TextButton(
              onPressed: () => navigator.pop(false),
              child: const Text('取消'),
            ),
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: palette.error,
                foregroundColor: palette.onError,
              ),
              onPressed: () => navigator.pop(true),
              child: const Text('移除'),
            ),
          ],
        );
      },
    );
    if (!mounted || accepted != true || _working) return;
    setState(() => _working = true);
    if (_selected == computer.computerKey) _leaveComputer();
    try {
      final cleared = await ref
          .read(computersProvider.notifier)
          .forget(computer);
      if (mounted) {
        setState(() => _feedback = cleared ? null : '电脑已移除，本机暂时无法清理全部记录。');
      }
    } catch (_) {
      if (mounted) setState(() => _feedback = '无法移除手机上保存的电脑。');
    } finally {
      if (mounted) {
        setState(() => _working = false);
        unawaited(_openQueuedReminder());
      }
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _reminders.watch();
    _reminderSettings.dispose();
    _shareSheetRevision.dispose();
    _reminders.setVisible(null, null).catchError((Object _) {});
    unawaited(_networks?.cancel());
    _session?.dispose();
    super.dispose();
  }

  Future<void> _openReminderSettings() => Navigator.of(context).push<void>(
    MaterialPageRoute(
      builder: (_) => ReminderSettingsPage(
        bridge: _reminders,
        settings: _reminderSettings,
        onChanged: _reminderSettingsChanged,
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    ref.listen<IncomingShareBatch?>(shareReceiverProvider, (previous, next) {
      if (next != null) _scheduleShareSheet();
    });
    final computers = ref.watch(computersProvider);
    final connectionLabel = _connectionLabel(context);
    final manager = Scaffold(
      appBar: AppBar(
        title: const Text('电脑'),
        actions: [
          Center(
            child: MobileGlassChromeButton(
              padding: const EdgeInsetsDirectional.only(end: 10),
              child: SizedBox.square(
                dimension: 40,
                child: IconButton(
                  tooltip: '通知设置',
                  padding: EdgeInsets.zero,
                  icon: const Icon(Icons.notifications_outlined, size: 20),
                  onPressed: _openReminderSettings,
                ),
              ),
            ),
          ),
        ],
        leadingWidth: _selected != null ? 58 : null,
        leading: _selected != null
            ? Align(
                alignment: AlignmentDirectional.centerStart,
                child: MobileGlassChromeButton(
                  padding: const EdgeInsetsDirectional.only(start: 10),
                  child: SizedBox.square(
                    dimension: 40,
                    child: BackButton(onPressed: () => _showWorkspace(true)),
                  ),
                ),
              )
            : null,
      ),
      body: SafeArea(
        top: false,
        child: computers.when(
          loading: () =>
              const Center(child: CircularProgressIndicator.adaptive()),
          error: (_, _) => Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text('无法读取系统凭据存储。'),
                TextButton(
                  onPressed: () => ref.invalidate(computersProvider),
                  child: const Text('重试'),
                ),
              ],
            ),
          ),
          data: (entries) => ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 20),
            children: [
              if (entries.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 16),
                  child: Text('在电脑打开「设置 → 手机连接」，生成二维码后用手机扫描。'),
                ),
              for (final entry in entries)
                ListTile(
                  key: ValueKey(entry.computerKey),
                  leading: const Icon(Icons.computer_outlined),
                  title: Text(entry.name),
                  subtitle: Text(
                    _selected == entry.computerKey ? connectionLabel : '点按连接',
                  ),
                  selected: _selected == entry.computerKey,
                  enabled: !_working,
                  onTap: () => unawaited(_choose(entry)),
                  trailing: IconButton(
                    tooltip: '移除 ${entry.name}',
                    icon: const Icon(Icons.remove_circle_outline),
                    onPressed: _working
                        ? null
                        : () => unawaited(_forget(entry)),
                  ),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
              const SizedBox(height: 12),
              if (_verification case final code?)
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Semantics(
                      liveRegion: true,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            _updatingRelay
                                ? '核对两端数字，在电脑确认更新中继。'
                                : '核对两端数字，在电脑点允许。',
                          ),
                          const SizedBox(height: 8),
                          Text(
                            code,
                            style: Theme.of(context).textTheme.headlineMedium,
                          ),
                        ],
                      ),
                    ),
                  ),
                )
              else if (_working)
                const LinearProgressIndicator(),
              if (_feedback case final feedback?)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: Semantics(liveRegion: true, child: Text(feedback)),
                ),
              Align(
                alignment: Alignment.centerLeft,
                child: FilledButton.icon(
                  onPressed: _working ? null : _scan,
                  icon: const Icon(Icons.qr_code_scanner),
                  label: Text(entries.isEmpty ? '扫码配对电脑' : '扫码配对或更新'),
                  style: FilledButton.styleFrom(minimumSize: const Size(0, 50)),
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(top: 16),
                child: Text(
                  '本机设备编号 ${ref.read(computersProvider.notifier).deviceNumber}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
              if (_version.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 16),
                  child: Text(
                    'Pigcode $_version',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
    final profile = computers.value
        ?.where((entry) => entry.computerKey == _selected)
        .firstOrNull;
    if (profile == null) return manager;
    return IndexedStack(
      index: _workspaceOpen ? 0 : 1,
      children: [
        MobileWorkspace(
          key: ValueKey(_selected),
          connection: _session?.connection,
          connected: _session?.connection != null,
          computer: profile,
          deviceId: ref.read(computersProvider.notifier).deviceId,
          cache: _cache,
          openReminder: _openReminder,
          openShareTarget: _openShareTarget,
          liveShare: _liveShare,
          presented: _workspaceOpen,
          onVisibleThread: (id) {
            _visibleThreadId = id;
            _syncVisibleThread();
          },
          onActiveTargetChanged: (target) {
            _activeThreadId = target.threadId;
            _activeDraftOpen = target.draftOpen;
            _notifyShareSheet();
          },
          onSidebarChanged: (snapshot) {
            _activeSidebar = snapshot;
            if (_selected case final key?) {
              _cachedSidebars[key] = snapshot;
            }
            _notifyShareSheet();
          },
          connectionLabel: connectionLabel,
          reconnect: () => _session?.retry(),
          onComputers: () => _showWorkspace(false),
          onSettings: _openReminderSettings,
        ),
        // Keep manager's hidden Scaffold isolated from MaterialApp's root
        // ScaffoldMessenger so pushed routes (Workbench/Terminal) popping with
        // an active SnackBar don't trigger duplicate SnackBar Hero tags.
        ScaffoldMessenger(child: manager),
      ],
    );
  }
}

class ScanPage extends StatefulWidget {
  const ScanPage({super.key});
  @override
  State<ScanPage> createState() => _ScanPageState();
}

class _ScanPageState extends State<ScanPage> {
  final _scanner = MobileScannerController(formats: [BarcodeFormat.qrCode]);
  bool _finished = false;

  @override
  void dispose() {
    unawaited(_scanner.dispose());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('扫描电脑上的二维码'),
      leadingWidth: 58,
      leading: Align(
        alignment: AlignmentDirectional.centerStart,
        child: MobileGlassChromeButton(
          padding: const EdgeInsetsDirectional.only(start: 10),
          child: const SizedBox.square(dimension: 40, child: BackButton()),
        ),
      ),
    ),
    body: SafeArea(
      child: MobileScanner(
        controller: _scanner,
        errorBuilder: (_, _) => const Center(
          child: Padding(
            padding: EdgeInsets.all(16),
            child: Text('相机不可用。请在系统设置允许 Pigcode 使用相机。'),
          ),
        ),
        onDetect: (capture) {
          if (_finished) return;
          for (final barcode in capture.barcodes) {
            final text = barcode.rawValue;
            if (text == null) continue;
            _finished = true;
            Navigator.of(context).pop(text);
            break;
          }
        },
      ),
    ),
  );
}

class _ShareSheetModal extends ConsumerStatefulWidget {
  const _ShareSheetModal({
    required this.revision,
    required this.busy,
    required this.resolveSelectedKey,
    required this.buildComputerInfo,
    required this.onSelectComputer,
    required this.onSelectTarget,
    required this.onPair,
    required this.onClose,
  });

  final ValueNotifier<int> revision;
  final bool Function() busy;
  final String? Function(List<ComputerProfile> computers) resolveSelectedKey;
  final ShareComputerTargetInfo Function(ComputerProfile computer)
  buildComputerInfo;
  final ValueChanged<ComputerProfile> onSelectComputer;
  final void Function(IncomingShareBatch batch, ShareTargetSelection selection)
  onSelectTarget;
  final VoidCallback onPair;
  final VoidCallback onClose;

  @override
  ConsumerState<_ShareSheetModal> createState() => _ShareSheetModalState();
}

class _ShareSheetModalState extends ConsumerState<_ShareSheetModal> {
  bool _popping = false;

  @override
  Widget build(BuildContext context) {
    final batch = ref.watch(shareReceiverProvider);
    if (batch == null) {
      if (!_popping) {
        _popping = true;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && Navigator.of(context).canPop()) {
            Navigator.of(context).pop();
          }
        });
      }
      return const SizedBox.shrink();
    }
    final computersAsync = ref.watch(computersProvider);
    final computers = computersAsync.value ?? const [];
    return ValueListenableBuilder<int>(
      valueListenable: widget.revision,
      builder: (context, _, _) {
        final selectedKey = widget.resolveSelectedKey(computers);
        final selectedComputer = selectedKey == null
            ? null
            : computers
                  .where((entry) => entry.computerKey == selectedKey)
                  .firstOrNull;
        final info = selectedComputer == null
            ? null
            : widget.buildComputerInfo(selectedComputer);
        final maxHeight = MediaQuery.sizeOf(context).height * .88;
        return ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: maxHeight > 0 ? maxHeight : double.infinity,
          ),
          child: ShareTargetSheet(
            batch: batch,
            computers: computers,
            computersLoading:
                computersAsync.isLoading && !computersAsync.hasValue,
            selectedComputerKey: selectedKey,
            computerInfo: info,
            busy: widget.busy(),
            onSelectComputer: widget.onSelectComputer,
            onRemoveImage: (index) =>
                ref.read(shareReceiverProvider.notifier).removeImageAt(index),
            onSelectTarget: (selection) =>
                widget.onSelectTarget(batch, selection),
            onPair: widget.onPair,
            onClose: widget.onClose,
          ),
        );
      },
    );
  }
}
