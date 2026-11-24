import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_mobile/mobile_status_dot.dart';

void main() {
  testWidgets('steps the running matrix and pauses when reduced or hidden', (
    tester,
  ) async {
    Widget app({bool reduced = false, bool visible = true}) => MaterialApp(
      home: MediaQuery(
        data: MediaQueryData(disableAnimations: reduced),
        child: TickerMode(
          enabled: visible,
          child: const Center(
            child: MobileRunningDotMatrix(color: Colors.black),
          ),
        ),
      ),
    );

    final matrix = find.byType(MobileRunningDotMatrix);
    final paint = find.descendant(
      of: matrix,
      matching: find.byType(CustomPaint),
    );
    CustomPainter painter() => tester.widget<CustomPaint>(paint).painter!;

    await tester.pumpWidget(app());
    expect(tester.getSize(matrix), const Size.square(10));
    final first = painter();
    await tester.pump(const Duration(milliseconds: 175));
    expect(painter().shouldRepaint(first), isTrue);

    await tester.pumpWidget(app(reduced: true));
    final still = painter();
    await tester.pump(const Duration(milliseconds: 350));
    expect(painter().shouldRepaint(still), isFalse);

    await tester.pumpWidget(app(visible: false));
    final hidden = painter();
    await tester.pump(const Duration(milliseconds: 350));
    expect(painter().shouldRepaint(hidden), isFalse);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
