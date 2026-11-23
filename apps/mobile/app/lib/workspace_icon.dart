import 'package:flutter/material.dart';

enum WorkspaceGlyph { menu, changes, compose }

class WorkspaceIcon extends StatelessWidget {
  const WorkspaceIcon(this.glyph, {super.key});

  final WorkspaceGlyph glyph;

  @override
  Widget build(BuildContext context) => CustomPaint(
    size: const Size.square(20),
    painter: _WorkspaceIconPainter(
      glyph,
      IconTheme.of(context).color ?? Theme.of(context).colorScheme.onSurface,
    ),
  );
}

class _WorkspaceIconPainter extends CustomPainter {
  const _WorkspaceIconPainter(this.glyph, this.color);

  final WorkspaceGlyph glyph;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(size.width / 24, size.height / 24);
    final stroke = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    switch (glyph) {
      case WorkspaceGlyph.menu:
        for (final y in [5.0, 12.0, 19.0]) {
          canvas.drawLine(Offset(4, y), Offset(20, y), stroke);
        }
      case WorkspaceGlyph.changes:
        canvas.drawPath(
          Path()
            ..moveTo(6, 22)
            ..quadraticBezierTo(4, 22, 4, 20)
            ..lineTo(4, 4)
            ..quadraticBezierTo(4, 2, 6, 2)
            ..lineTo(14, 2)
            ..lineTo(20, 8)
            ..lineTo(20, 20)
            ..quadraticBezierTo(20, 22, 18, 22)
            ..close(),
          stroke,
        );
        canvas.drawLine(const Offset(9, 10), const Offset(15, 10), stroke);
        canvas.drawLine(const Offset(12, 7), const Offset(12, 13), stroke);
        canvas.drawLine(const Offset(9, 17), const Offset(15, 17), stroke);
      case WorkspaceGlyph.compose:
        canvas.drawPath(
          Path()
            ..moveTo(12, 3)
            ..lineTo(5, 3)
            ..quadraticBezierTo(3, 3, 3, 5)
            ..lineTo(3, 19)
            ..quadraticBezierTo(3, 21, 5, 21)
            ..lineTo(19, 21)
            ..quadraticBezierTo(21, 21, 21, 19)
            ..lineTo(21, 12)
            ..moveTo(18.4, 2.6)
            ..quadraticBezierTo(20, 1.2, 21.4, 2.6)
            ..quadraticBezierTo(22.8, 4, 21.4, 5.6)
            ..lineTo(12, 15)
            ..lineTo(8, 16)
            ..lineTo(9, 12)
            ..close(),
          stroke,
        );
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_WorkspaceIconPainter oldDelegate) =>
      oldDelegate.glyph != glyph || oldDelegate.color != color;
}
