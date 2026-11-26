import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/app_theme.dart';
import 'package:pigcode_mobile/terminal/mobile_terminal_screen.dart';
import 'package:pigcode_mobile/terminal/terminal_expanded_keyboard.dart';
import 'package:pigcode_mobile/terminal/terminal_shortcut_bar.dart';
import 'package:xterm2/xterm.dart';

class _FakeTerminalHost implements HostRequests {
  _FakeTerminalHost({List<Map<String, dynamic>>? initialTerminals})
    : terminals = initialTerminals ?? [];

  final List<Map<String, dynamic>> terminals;
  final calls = <(String, Map<String, Object?>)>[];
  final writes = <(String, String)>[];
  final resizes = <(String, int, int)>[];
  final _notifications = StreamController<Map<String, dynamic>>.broadcast();
  bool nextAttachTruncated = false;
  int _nextNum = 1;

  @override
  Stream<Map<String, dynamic>> get notifications => _notifications.stream;

  void emitOutput(
    String terminalId,
    String text, {
    required int cursor,
    bool replay = false,
    bool overflow = false,
  }) {
    _notifications.add({
      'jsonrpc': '2.0',
      'method': MobileTerminalNotifications.output,
      'params': {
        'terminalId': terminalId,
        'dataBase64': text.isEmpty ? '' : base64Encode(utf8.encode(text)),
        'cursor': cursor,
        if (replay) 'replay': true,
        if (overflow) 'overflow': true,
      },
    });
  }

  void emitExit(String terminalId, int exitCode) {
    _notifications.add({
      'jsonrpc': '2.0',
      'method': MobileTerminalNotifications.exit,
      'params': {'terminalId': terminalId, 'exitCode': exitCode},
    });
  }

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add((method, Map<String, Object?>.from(params)));
    switch (method) {
      case MobileTerminalMethods.list:
        return {
          'terminals': terminals
              .map((t) => Map<String, dynamic>.from(t))
              .toList(),
        };
      case MobileTerminalMethods.open:
        final id = 'term_m_${_nextNum++}';
        final item = <String, dynamic>{
          'id': id,
          'threadId': params['threadId'] as String,
          'shell': 'zsh',
          'cwdLabel': 'pigcode',
          'cols': params['cols'] as int,
          'rows': params['rows'] as int,
          'cursor': 0,
          'origin': 'mobile',
          'writable': true,
          'createdAt': '2026-11-26T00:00:00.000Z',
        };
        terminals.add(item);
        return {'terminal': Map<String, dynamic>.from(item)};
      case MobileTerminalMethods.attach:
        final id = params['terminalId'] as String;
        final item = terminals.firstWhere((t) => t['id'] == id);
        final truncated = nextAttachTruncated;
        nextAttachTruncated = false;
        return {
          'terminal': Map<String, dynamic>.from(item),
          'cursor': item['cursor'] as int,
          'replayChunks': 0,
          'truncated': truncated,
        };
      case MobileTerminalMethods.detach:
        return {'ok': true};
      case MobileTerminalMethods.write:
        final id = params['terminalId'] as String;
        final decoded = utf8.decode(
          base64Decode(params['dataBase64'] as String),
        );
        writes.add((id, decoded));
        return {'ok': true};
      case MobileTerminalMethods.resize:
        final id = params['terminalId'] as String;
        final cols = params['cols'] as int;
        final rows = params['rows'] as int;
        resizes.add((id, cols, rows));
        return {'cols': cols, 'rows': rows};
      case MobileTerminalMethods.close:
        final id = params['terminalId'] as String;
        terminals.removeWhere((t) => t['id'] == id);
        return {'closed': true};
      default:
        throw StateError('Unexpected method: $method');
    }
  }

  Future<void> dispose() => _notifications.close();
}

class _FakeTerminalConnection implements MobileConnection {
  _FakeTerminalConnection(this.host, {this.supportsTerminal = true})
    : terminal = MobileTerminalClient(host, supportsTerminal: supportsTerminal);

  final _FakeTerminalHost host;
  final _done = Completer<void>();

  @override
  final bool supportsTerminal;

  @override
  final MobileTerminalClient terminal;

  @override
  Future<void> get done => _done.future;

  void disconnect() {
    if (!_done.isCompleted) _done.complete();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Widget _app(Widget child) =>
    MaterialApp(theme: pigcodeTheme(Brightness.light), home: child);

void main() {
  test(
    'applyStickyCtrl converts ASCII letters and brackets to control codes',
    () {
      expect(applyStickyCtrl('c'), '\x03');
      expect(applyStickyCtrl('C'), '\x03');
      expect(applyStickyCtrl('d'), '\x04');
      expect(applyStickyCtrl('z'), '\x1a');
      expect(applyStickyCtrl('['), '\x1b');
      expect(applyStickyCtrl('ab'), 'ab');
      expect(applyTerminalModifiers('b', alt: true), '\x1bb');
      expect(applyTerminalModifiers('c', ctrl: true, alt: true), '\x1b\x03');
    },
  );

  testWidgets(
    'auto-opens mobile terminal on empty list and sends shortcut bar sequences + sticky Ctrl',
    (tester) async {
      final host = _FakeTerminalHost();
      addTearDown(host.dispose);
      final conn = _FakeTerminalConnection(host);
      final notifier = ValueNotifier<MobileConnection?>(conn);
      addTearDown(notifier.dispose);

      await tester.pumpWidget(
        _app(
          MobileTerminalScreen(
            connectionListenable: notifier,
            threadId: 'th_1',
            resizeDebounce: const Duration(milliseconds: 10),
            readClipboard: () async => 'pasted-cmd',
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(host.calls.any((c) => c.$1 == MobileTerminalMethods.open), isTrue);
      expect(find.byKey(TerminalShortcutBar.ctrlCKey), findsOneWidget);

      Future<void> tapShortcut(Key key) async {
        final finder = find.byKey(key);
        await tester.ensureVisible(finder);
        await tester.tap(finder);
      }

      await tapShortcut(TerminalShortcutBar.escKey);
      await tapShortcut(TerminalShortcutBar.tabKey);
      await tapShortcut(TerminalShortcutBar.ctrlCKey);
      await tapShortcut(TerminalShortcutBar.upKey);
      await tapShortcut(TerminalShortcutBar.pasteKey);
      await tapShortcut(TerminalShortcutBar.clearKey);
      await tester.pumpAndSettle();

      expect(host.writes.map((e) => e.$2).toList(), [
        '\x1b',
        '\t',
        '\x03',
        '\x1b[A',
        'pasted-cmd',
        '\x0c',
      ]);

      // Arm sticky Ctrl once and emit 'd' through Terminal.onOutput -> '\x04'
      await tapShortcut(TerminalShortcutBar.ctrlKey);
      await tester.pump();
      final termView = tester.widget<TerminalView>(
        find.byKey(const ValueKey('xterm-term_m_1')),
      );
      termView.terminal.onOutput?.call('d');
      await tester.pumpAndSettle();
      expect(host.writes.last.$2, '\x04');

      // Second char after single-use Ctrl sends plain character 'd'
      termView.terminal.onOutput?.call('d');
      await tester.pumpAndSettle();
      expect(host.writes.last.$2, 'd');
    },
  );

  testWidgets(
    'expanded UU two-screen terminal keyboard: screen1 QWERTY/dual-symbols, screen2 F-keys/nav, comboMode, page swipe & floating pill on 360px screen',
    (tester) async {
      tester.view.physicalSize = const Size(360, 780);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      final host = _FakeTerminalHost();
      addTearDown(host.dispose);
      final conn = _FakeTerminalConnection(host);
      final notifier = ValueNotifier<MobileConnection?>(conn);
      addTearDown(notifier.dispose);

      await tester.pumpWidget(
        _app(
          MobileTerminalScreen(
            connectionListenable: notifier,
            threadId: 'th_1',
            resizeDebounce: const Duration(milliseconds: 10),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Expand UU-style 2-screen PC terminal keyboard (pill stays visible above it)
      await tester.tap(find.byKey(TerminalShortcutBar.expandKey));
      await tester.pumpAndSettle();
      expect(find.byKey(TerminalExpandedKeyboard.panelKey), findsOneWidget);
      expect(find.byKey(TerminalShortcutBar.hideKeyboardKey), findsOneWidget);

      // Screen 1: QWERTY letters, numbers, Space, Enter & dual-symbol Shift behavior
      await tester.tap(find.text('q'));
      await tester.tap(find.text('1'));
      await tester.tap(find.text('-'));
      await tester.tap(find.text('Space'));
      await tester.tap(find.byKey(TerminalExpandedKeyboard.enterKey));
      await tester.pumpAndSettle();

      expect(
        host.writes.map((e) => e.$2).toList(),
        containsAllInOrder(['q', '1', '-', ' ', '\r']),
      );

      // Single-shot Shift: produces upper symbol '+' and uppercase 'A', then auto-releases
      await tester.tap(find.byKey(TerminalExpandedKeyboard.shiftKey));
      await tester.pump();
      await tester.tap(find.text('='));
      await tester.pump();
      await tester.tap(find.text('='));
      await tester.pump();
      await tester.tap(find.byKey(TerminalExpandedKeyboard.shiftKey));
      await tester.pump();
      await tester.tap(find.text('A'));
      await tester.pump();
      await tester.tap(find.text('a'));
      await tester.pumpAndSettle();
      expect(
        host.writes.sublist(host.writes.length - 4).map((e) => e.$2).toList(),
        ['+', '=', 'A', 'a'],
      );

      // Combo mode checkbox keeps Ctrl active across multiple keystrokes
      await tester.tap(find.byKey(TerminalExpandedKeyboard.comboModeKey));
      await tester.tap(find.byKey(TerminalExpandedKeyboard.ctrlKey));
      await tester.pump();
      await tester.tap(find.text('c'));
      await tester.tap(find.text('d'));
      await tester.pumpAndSettle();
      expect(
        host.writes.sublist(host.writes.length - 2).map((e) => e.$2).toList(),
        ['\x03', '\x04'],
      );
      // Unchecking combo mode clears held single-shot modifiers
      await tester.tap(find.byKey(TerminalExpandedKeyboard.comboModeKey));
      await tester.pump();

      // Swipe left to Screen 2 (F1-F12, Home/End/PgUp/PgDn/Ins/Del, Caps, arrows)
      await tester.fling(
        find.byKey(TerminalExpandedKeyboard.pagerKey),
        const Offset(-300, 0),
        900,
      );
      await tester.pumpAndSettle();
      expect(find.text('F5'), findsOneWidget);

      await tester.tap(find.text('F5'));
      await tester.tap(find.text('Home'));
      await tester.tap(find.byKey(TerminalExpandedKeyboard.shiftTabKey));
      await tester.tap(find.byKey(TerminalExpandedKeyboard.crossUpKey));
      await tester.tap(find.text('^R'));
      await tester.pumpAndSettle();
      expect(
        host.writes.sublist(host.writes.length - 5).map((e) => e.$2).toList(),
        ['\x1b[15~', '\x1b[H', '\x1b[Z', '\x1b[A', '\x12'],
      );

      // Modified arrow key: Ctrl + ↑ -> \x1b[1;5A
      await tester.tap(find.byKey(TerminalExpandedKeyboard.ctrlKey));
      await tester.pump();
      await tester.tap(find.byKey(TerminalExpandedKeyboard.crossUpKey));
      await tester.pumpAndSettle();
      expect(host.writes.last.$2, '\x1b[1;5A');

      // Single-shot Alt on Screen 1 -> ESC + '/'
      await tester.tap(find.byKey(TerminalExpandedKeyboard.pageDot0Key));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(TerminalExpandedKeyboard.altKey));
      await tester.pump();
      await tester.tap(find.text('/'));
      await tester.pumpAndSettle();
      expect(host.writes.last.$2, '\x1b/');

      // Collapse controls from top pill -> shows floating pill; reopen expanded keyboard from pill
      await tester.tap(find.byKey(TerminalShortcutBar.hideKeyboardKey));
      await tester.pumpAndSettle();
      expect(find.byKey(TerminalFloatingPill.pillKey), findsOneWidget);
      expect(find.byKey(TerminalExpandedKeyboard.panelKey), findsNothing);

      await tester.tap(find.byKey(TerminalFloatingPill.openExpandedKey));
      await tester.pumpAndSettle();
      expect(find.byKey(TerminalExpandedKeyboard.panelKey), findsOneWidget);

      // Multi-finger rollover (overlap pressing 'w' then 'e') fires both without GestureArena stall
      final wCenter = tester.getCenter(find.text('w'));
      final eCenter = tester.getCenter(find.text('e'));
      final g1 = await tester.startGesture(wCenter);
      final g2 = await tester.startGesture(eCenter);
      await tester.pump();
      await g1.up();
      await g2.up();
      await tester.pumpAndSettle();
      expect(
        host.writes.sublist(host.writes.length - 2).map((e) => e.$2).toList(),
        ['w', 'e'],
      );

      // Dragging horizontally directly from a key switches pages cleanly without misfiring that key
      final writeCountBeforeSwipe = host.writes.length;
      await tester.drag(find.text('t'), const Offset(-260, 0));
      await tester.pumpAndSettle();
      expect(find.text('F5'), findsOneWidget);
      expect(host.writes.length, writeCountBeforeSwipe);

      // Verify modifier encoding helpers
      expect(
        encodeModifiedSpecialKey('\x1b[A', ctrl: true, shift: true),
        '\x1b[1;6A',
      );
      expect(encodeModifiedSpecialKey('\x03', alt: true), '\x03');
      expect(encodeModifiedSpecialKey('\x7f', alt: true), '\x1b\x7f');
    },
  );

  testWidgets(
    'keeps desktop terminal strictly read-only without shortcut bar, close action, or resize',
    (tester) async {
      final host = _FakeTerminalHost(
        initialTerminals: [
          {
            'id': 'term_desk_1',
            'threadId': 'th_1',
            'shell': 'zsh',
            'cwdLabel': 'monorepo',
            'cols': 120,
            'rows': 36,
            'cursor': 12,
            'origin': 'desktop',
            'writable': false,
            'createdAt': '2026-11-26T00:00:00.000Z',
          },
        ],
      );
      addTearDown(host.dispose);
      final conn = _FakeTerminalConnection(host);
      final notifier = ValueNotifier<MobileConnection?>(conn);
      addTearDown(notifier.dispose);

      await tester.pumpWidget(
        _app(
          MobileTerminalScreen(
            connectionListenable: notifier,
            threadId: 'th_1',
            resizeDebounce: const Duration(milliseconds: 10),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(MobileTerminalScreen.readOnlyBannerKey),
        findsOneWidget,
      );
      expect(find.text('只读'), findsOneWidget);
      expect(find.byKey(TerminalShortcutBar.ctrlCKey), findsNothing);
      expect(host.resizes, isEmpty);
      expect(host.writes, isEmpty);

      // Attach call on desktop terminal must NOT send cols/rows
      final attachCall = host.calls.firstWhere(
        (c) => c.$1 == MobileTerminalMethods.attach,
      );
      expect(attachCall.$2.containsKey('cols'), isFalse);
      expect(attachCall.$2.containsKey('rows'), isFalse);

      // Open switcher sheet: desktop terminal has no close button
      await tester.tap(find.byKey(MobileTerminalScreen.switcherButtonKey));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('terminal-sheet-item-term_desk_1')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('terminal-sheet-close-term_desk_1')),
        findsNothing,
      );

      // Create new mobile terminal from sheet -> switches to writable terminal
      await tester.tap(find.text('新建手机终端').last);
      await tester.pumpAndSettle();
      expect(find.byKey(MobileTerminalScreen.readOnlyBannerKey), findsNothing);
      expect(find.byKey(TerminalShortcutBar.ctrlCKey), findsOneWidget);

      // Open switcher again -> mobile terminal CAN be closed
      await tester.tap(find.byKey(MobileTerminalScreen.switcherButtonKey));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('terminal-sheet-close-term_m_1')),
      );
      await tester.pumpAndSettle();
      expect(
        host.calls.any((c) => c.$1 == MobileTerminalMethods.close),
        isTrue,
      );
    },
  );

  testWidgets(
    'resumes attached terminal with afterCursor across disconnect/reconnect and handles truncated & exit',
    (tester) async {
      final host1 = _FakeTerminalHost();
      addTearDown(host1.dispose);
      final conn1 = _FakeTerminalConnection(host1);
      final notifier = ValueNotifier<MobileConnection?>(conn1);
      addTearDown(notifier.dispose);

      await tester.pumpWidget(
        _app(
          MobileTerminalScreen(
            connectionListenable: notifier,
            threadId: 'th_1',
            resizeDebounce: const Duration(milliseconds: 10),
          ),
        ),
      );
      await tester.pumpAndSettle();

      host1.emitOutput('term_m_1', 'hello ', cursor: 6);
      await tester.pump();

      // Simulate disconnect -> offline banner shown
      notifier.value = null;
      await tester.pumpAndSettle();
      expect(find.byKey(MobileTerminalScreen.offlineBannerKey), findsOneWidget);

      // Reconnect with same terminal still alive on Host
      final host2 = _FakeTerminalHost(
        initialTerminals: [
          {
            'id': 'term_m_1',
            'threadId': 'th_1',
            'shell': 'zsh',
            'cwdLabel': 'pigcode',
            'cols': 48,
            'rows': 24,
            'cursor': 12,
            'origin': 'mobile',
            'writable': true,
            'createdAt': '2026-11-26T00:00:00.000Z',
          },
        ],
      )..nextAttachTruncated = true;
      addTearDown(host2.dispose);
      final conn2 = _FakeTerminalConnection(host2);
      notifier.value = conn2;
      await tester.pumpAndSettle();

      expect(find.byKey(MobileTerminalScreen.offlineBannerKey), findsNothing);
      final attachCall = host2.calls.firstWhere(
        (c) => c.$1 == MobileTerminalMethods.attach,
      );
      expect(attachCall.$2['terminalId'], 'term_m_1');
      expect(attachCall.$2['afterCursor'], 6);
      expect(find.text('断线期间输出较多，已回放最近内容'), findsOneWidget);

      // Emit exit -> shows exited banner with exit code
      host2.emitExit('term_m_1', 130);
      await tester.pumpAndSettle();
      expect(find.byKey(MobileTerminalScreen.exitedBannerKey), findsOneWidget);
      expect(find.text('终端进程已退出（退出码 130）'), findsOneWidget);
    },
  );
}
