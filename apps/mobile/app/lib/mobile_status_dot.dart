import 'package:flutter/material.dart';

class MobileStatusDot extends StatelessWidget {
  const MobileStatusDot({super.key, required this.color});

  final Color color;

  @override
  Widget build(BuildContext context) => SizedBox.square(
    dimension: 6,
    child: DecoratedBox(
      decoration: BoxDecoration(shape: BoxShape.circle, color: color),
    ),
  );
}

class MobileRunningDotMatrix extends StatefulWidget {
  const MobileRunningDotMatrix({super.key, required this.color});

  final Color color;

  @override
  State<MobileRunningDotMatrix> createState() => _MobileRunningDotMatrixState();
}

// 方案 D 的 3×3 点阵，每帧 175ms。减少动效时停在第 3 帧。
const _frames = [
  [3, 5, 6, 8],
  [0, 3, 7, 8],
  [0, 3, 4, 7],
  [0, 1, 3, 4, 8],
  [1, 3, 4, 5, 6, 8],
  [1, 2, 4, 5, 6],
  [2, 4, 5, 7],
  [2, 5, 6, 7],
];

class _MobileRunningDotMatrixState extends State<MobileRunningDotMatrix>
    with SingleTickerProviderStateMixin {
  late final _animation = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  )..addListener(_advance);
  int _frame = 0;

  void _advance() {
    final next = (_animation.value * _frames.length).floor() % _frames.length;
    if (next != _frame) setState(() => _frame = next);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final reducedMotion = MediaQuery.disableAnimationsOf(context);
    final visible = TickerMode.valuesOf(context).enabled;
    if (reducedMotion || !visible) {
      _animation.stop();
      _frame = reducedMotion ? 3 : 0;
    } else if (!_animation.isAnimating) {
      _frame = 0;
      _animation
        ..value = 0
        ..repeat();
    }
  }

  @override
  void dispose() {
    _animation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => CustomPaint(
    size: const Size.square(10),
    painter: _DotMatrixPainter(widget.color, _frame),
  );
}

class _DotMatrixPainter extends CustomPainter {
  const _DotMatrixPainter(this.color, this.frame);

  final Color color;
  final int frame;

  @override
  void paint(Canvas canvas, Size size) {
    final fill = Paint()..color = color;
    for (final cell in _frames[frame]) {
      canvas.drawCircle(
        Offset(1 + (cell % 3) * 4.0, 1 + (cell ~/ 3) * 4.0),
        1,
        fill,
      );
    }
  }

  @override
  bool shouldRepaint(_DotMatrixPainter oldDelegate) =>
      oldDelegate.frame != frame || oldDelegate.color != color;
}
