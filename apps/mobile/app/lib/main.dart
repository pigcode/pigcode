import 'dart:async';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/cupertino.dart' show CupertinoDialogAction;
import 'package:flutter/foundation.dart' show setEquals;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

import 'computer_reconnect.dart';
import 'computers.dart';
import 'offline_cache.dart';
import 'theme_colors.dart';
import 'workspace.dart';

const _version = String.fromEnvironment('PIGCODE_PRODUCT_VERSION');

void main() {
  runApp(const ProviderScope(child: PigcodeApp()));
}

class PigcodeApp extends StatelessWidget {
  const PigcodeApp({super.key});

  ThemeData _theme(Brightness brightness) {
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;
    final scheme = ColorScheme(
      brightness: brightness,
      primary: colors.primary,
      onPrimary: colors.onPrimary,
      secondary: colors.primary,
      onSecondary: colors.onPrimary,
      error: colors.error,
      onError: colors.onError,
      surface: colors.surface,
      onSurface: colors.foreground,
      onSurfaceVariant: colors.secondaryText,
      outlineVariant: colors.divider,
    );
    final theme = ThemeData(
      colorScheme: scheme,
      scaffoldBackgroundColor: colors.background,
      cardTheme: CardThemeData(color: colors.surface),
      listTileTheme: ListTileThemeData(selectedTileColor: colors.selected),
      visualDensity: VisualDensity.standard,
    );
    final text = theme.textTheme;
    const body = TextStyle(
      fontSize: 15,
      height: 1.45,
      fontWeight: FontWeight.w400,
    );
    return theme.copyWith(
      textTheme: text.copyWith(
        bodyLarge: text.bodyLarge?.merge(body),
        bodyMedium: text.bodyMedium?.merge(body),
        labelLarge: text.labelLarge?.copyWith(fontWeight: FontWeight.w500),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Pigcode',
    debugShowCheckedModeBanner: false,
    theme: _theme(Brightness.light),
    darkTheme: _theme(Brightness.dark),
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

  @override
  void initState() {
    super.initState();
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    _foreground =
        lifecycle == null ||
        lifecycle == AppLifecycleState.resumed ||
        lifecycle == AppLifecycleState.inactive;
    WidgetsBinding.instance.addObserver(this);
    final connectivity = Connectivity();
    _networks = connectivity.onConnectivityChanged.listen((networks) {
      final next = networks.toSet();
      final previous = _network;
      _network = next;
      if (previous != null && !setEquals(previous, next)) _session?.retry();
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
  }

  void _select(ComputerProfile computer, {MobileConnection? initial}) {
    final identity = ref.read(computersProvider.notifier).identity;
    late final ComputerReconnect session;
    session = ComputerReconnect(
      dial: () => MobileConnection.resume(computer, identity),
      observe: () => RelayStatusWatch.open(computer),
      onChange: () {
        if (!mounted || !identical(_session, session)) return;
        if (session.error == 'device-revoked') {
          unawaited(_confirmedRevocation(computer));
        } else {
          setState(() {});
        }
      },
    );
    _session?.dispose();
    setState(() {
      _session = session;
      _selected = computer.computerKey;
      _cache = ref.read(offlineCacheProvider).open(computer.computerKey);
      _workspaceOpen = true;
      _feedback = null;
    });
    session.start(foreground: _foreground, initial: initial);
  }

  Future<void> _choose(
    ComputerProfile computer, {
    PairingInvite? invite,
  }) async {
    if (_working) return;
    if (invite == null) {
      if (_selected == computer.computerKey) {
        setState(() => _workspaceOpen = true);
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
      _updatingRelay = existing != null;
      _verification = null;
      _feedback = null;
      _selected = null;
    });

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
      if (mounted) setState(() => _working = false);
    }
  }

  void _leaveComputer() {
    _session?.dispose();
    setState(() {
      _session = null;
      _selected = null;
      _cache = null;
      _workspaceOpen = false;
    });
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
    final accepted = await showAdaptiveDialog<bool>(
      context: context,
      builder: (dialog) {
        final navigator = Navigator.of(dialog);
        final ios = Theme.of(dialog).platform == TargetPlatform.iOS;
        return AlertDialog.adaptive(
          title: Text('移除「${computer.name}」'),
          content: const Text('移除手机上保存的连接配置。再次连接时需要扫码配对。'),
          actions: ios
              ? [
                  CupertinoDialogAction(
                    onPressed: () => navigator.pop(false),
                    child: const Text('取消'),
                  ),
                  CupertinoDialogAction(
                    isDestructiveAction: true,
                    onPressed: () => navigator.pop(true),
                    child: const Text('移除'),
                  ),
                ]
              : [
                  TextButton(
                    onPressed: () => navigator.pop(false),
                    child: const Text('取消'),
                  ),
                  TextButton(
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
      if (mounted) setState(() => _working = false);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_networks?.cancel());
    _session?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final computers = ref.watch(computersProvider);
    final connectionLabel = _connectionLabel(context);
    final manager = Scaffold(
      appBar: AppBar(
        title: const Text('电脑'),
        leading: _selected != null
            ? BackButton(onPressed: () => setState(() => _workspaceOpen = true))
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
          connectionLabel: connectionLabel,
          reconnect: () => _session?.retry(),
          onComputers: () => setState(() => _workspaceOpen = false),
        ),
        manager,
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
    appBar: AppBar(title: const Text('扫描电脑上的二维码')),
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
