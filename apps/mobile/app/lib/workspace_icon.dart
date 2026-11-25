import 'package:flutter/material.dart';

enum WorkspaceGlyph {
  menu,
  changes,
  compose,
  folder,
  folderOpen,
  chevronDown,
  arrowUp,
  stop,
  search,
  copy,
  hand,
  question,
  questionCircle,
  fileText,
  fileCode,
  laptop,
  settings,
  sliders,
  plus,
  close,
  pin,
  pinOff,
  mail,
  mailOpen,
  archive,
  archiveRestore,
  pencil,
  terminal,
  star,
  starFilled,
  zap,
  zapFilled,
  workflow,
  listChecks,
  bot,
  sparkles,
  shieldAlert,
  check,
  lock,
  atSign,
  slash,
  messagesSquare,
  dollarSign,
}

class WorkspaceIcon extends StatelessWidget {
  const WorkspaceIcon(this.glyph, {this.size = 20, super.key});

  final WorkspaceGlyph glyph;
  final double size;

  @override
  Widget build(BuildContext context) => CustomPaint(
    size: Size.square(size),
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
      case WorkspaceGlyph.changes ||
          WorkspaceGlyph.fileText ||
          WorkspaceGlyph.fileCode:
        canvas.drawPath(
          Path()
            ..moveTo(6, 22)
            ..quadraticBezierTo(4, 22, 4, 20)
            ..lineTo(4, 4)
            ..quadraticBezierTo(4, 2, 6, 2)
            ..lineTo(14, 2)
            ..arcToPoint(
              const Offset(15.704, 2.706),
              radius: const Radius.circular(2.4),
            )
            ..lineTo(19.292, 6.294)
            ..arcToPoint(
              const Offset(20, 8),
              radius: const Radius.circular(2.4),
            )
            ..lineTo(20, 20)
            ..quadraticBezierTo(20, 22, 18, 22)
            ..close(),
          stroke,
        );
        if (glyph == WorkspaceGlyph.changes) {
          canvas.drawLine(const Offset(9, 10), const Offset(15, 10), stroke);
          canvas.drawLine(const Offset(12, 7), const Offset(12, 13), stroke);
          canvas.drawLine(const Offset(9, 17), const Offset(15, 17), stroke);
        } else {
          canvas.drawPath(
            Path()
              ..moveTo(14, 2)
              ..lineTo(14, 7)
              ..arcToPoint(
                const Offset(15, 8),
                radius: const Radius.circular(1),
                clockwise: false,
              )
              ..lineTo(20, 8),
            stroke,
          );
          if (glyph == WorkspaceGlyph.fileCode) {
            canvas.drawPath(
              Path()
                ..moveTo(10, 12.5)
                ..lineTo(8, 15)
                ..lineTo(10, 17.5)
                ..moveTo(14, 12.5)
                ..lineTo(16, 15)
                ..lineTo(14, 17.5),
              stroke,
            );
          } else {
            canvas.drawLine(const Offset(8, 9), const Offset(10, 9), stroke);
            canvas.drawLine(const Offset(8, 13), const Offset(16, 13), stroke);
            canvas.drawLine(const Offset(8, 17), const Offset(16, 17), stroke);
          }
        }
      case WorkspaceGlyph.laptop:
        const corner = Radius.circular(2);
        canvas.drawPath(
          Path()
            ..moveTo(18, 5)
            ..arcToPoint(const Offset(20, 7), radius: corner)
            ..lineTo(20, 15.526)
            ..arcToPoint(
              const Offset(20.212, 16.423),
              radius: corner,
              clockwise: false,
            )
            ..lineTo(21.28, 18.55)
            ..arcToPoint(
              const Offset(20.38, 20),
              radius: const Radius.circular(1),
            )
            ..lineTo(3.62, 20)
            ..arcToPoint(
              const Offset(2.72, 18.55),
              radius: const Radius.circular(1),
            )
            ..lineTo(3.788, 16.423)
            ..arcToPoint(
              const Offset(4, 15.526),
              radius: corner,
              clockwise: false,
            )
            ..lineTo(4, 7)
            ..arcToPoint(const Offset(6, 5), radius: corner)
            ..close(),
          stroke,
        );
        canvas.drawLine(
          const Offset(20.054, 15.987),
          const Offset(3.946, 15.987),
          stroke,
        );
      case WorkspaceGlyph.pencil:
        canvas.drawPath(
          Path()
            ..moveTo(21.174, 6.812)
            ..arcToPoint(
              const Offset(17.188, 2.825),
              radius: const Radius.circular(1),
              clockwise: false,
            )
            ..lineTo(3.842, 16.174)
            ..arcToPoint(
              const Offset(3.342, 17.004),
              radius: const Radius.circular(2),
              clockwise: false,
            )
            ..lineTo(2.021, 21.356)
            ..arcToPoint(
              const Offset(2.644, 21.978),
              radius: const Radius.circular(.5),
              clockwise: false,
            )
            ..lineTo(6.997, 20.658)
            ..arcToPoint(
              const Offset(7.827, 20.161),
              radius: const Radius.circular(2),
              clockwise: false,
            )
            ..close()
            ..moveTo(15, 5)
            ..lineTo(19, 9),
          stroke,
        );
      case WorkspaceGlyph.terminal:
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(3, 3, 18, 18),
            const Radius.circular(2),
          ),
          stroke,
        );
        canvas.drawPath(
          Path()
            ..moveTo(7, 11)
            ..lineTo(9, 9)
            ..lineTo(7, 7),
          stroke,
        );
        canvas.drawLine(const Offset(11, 13), const Offset(15, 13), stroke);
      case WorkspaceGlyph.compose:
        canvas.drawPath(
          Path()
            ..moveTo(12, 3)
            ..lineTo(5, 3)
            ..arcToPoint(
              const Offset(3, 5),
              radius: const Radius.circular(2),
              clockwise: false,
            )
            ..lineTo(3, 19)
            ..arcToPoint(
              const Offset(5, 21),
              radius: const Radius.circular(2),
              clockwise: false,
            )
            ..lineTo(19, 21)
            ..arcToPoint(
              const Offset(21, 19),
              radius: const Radius.circular(2),
              clockwise: false,
            )
            ..lineTo(21, 12)
            ..moveTo(18.375, 2.625)
            ..arcToPoint(
              const Offset(21.375, 5.625),
              radius: const Radius.circular(1),
            )
            ..lineTo(12.362, 14.639)
            ..arcToPoint(
              const Offset(11.509, 15.144),
              radius: const Radius.circular(2),
            )
            ..lineTo(8.636, 15.984)
            ..arcToPoint(
              const Offset(8.016, 15.364),
              radius: const Radius.circular(.5),
            )
            ..lineTo(8.856, 12.491)
            ..arcToPoint(
              const Offset(9.362, 11.639),
              radius: const Radius.circular(2),
            )
            ..close(),
          stroke,
        );
      case WorkspaceGlyph.folder:
        canvas.drawPath(
          Path()
            ..moveTo(20, 20)
            ..arcToPoint(
              const Offset(22, 18),
              radius: const Radius.circular(2),
              clockwise: false,
            )
            ..lineTo(22, 8)
            ..arcToPoint(
              const Offset(20, 6),
              radius: const Radius.circular(2),
              clockwise: false,
            )
            ..lineTo(12.1, 6)
            ..arcToPoint(
              const Offset(10.41, 5.1),
              radius: const Radius.circular(2),
            )
            ..lineTo(9.6, 3.9)
            ..arcToPoint(
              const Offset(7.93, 3),
              radius: const Radius.circular(2),
              clockwise: false,
            )
            ..lineTo(4, 3)
            ..arcToPoint(
              const Offset(2, 5),
              radius: const Radius.circular(2),
              clockwise: false,
            )
            ..lineTo(2, 18)
            ..arcToPoint(
              const Offset(4, 20),
              radius: const Radius.circular(2),
              clockwise: false,
            )
            ..close(),
          stroke,
        );
      case WorkspaceGlyph.chevronDown:
        canvas.drawPath(
          Path()
            ..moveTo(6, 9)
            ..lineTo(12, 15)
            ..lineTo(18, 9),
          stroke,
        );
      case WorkspaceGlyph.folderOpen:
        const corner = Radius.circular(2);
        canvas.drawPath(
          Path()
            ..moveTo(6, 14)
            ..lineTo(7.5, 11.1)
            ..arcToPoint(const Offset(9.24, 10), radius: corner)
            ..lineTo(20, 10)
            ..arcToPoint(const Offset(21.94, 12.5), radius: corner)
            ..lineTo(20.4, 18.5)
            ..arcToPoint(const Offset(18.45, 20), radius: corner)
            ..lineTo(4, 20)
            ..arcToPoint(const Offset(2, 18), radius: corner)
            ..lineTo(2, 5)
            ..arcToPoint(const Offset(4, 3), radius: corner)
            ..lineTo(7.9, 3)
            ..arcToPoint(const Offset(9.59, 3.9), radius: corner)
            ..lineTo(10.4, 5.1)
            ..arcToPoint(
              const Offset(12.07, 6),
              radius: corner,
              clockwise: false,
            )
            ..lineTo(18, 6)
            ..arcToPoint(const Offset(20, 8), radius: corner)
            ..lineTo(20, 10),
          stroke,
        );
      case WorkspaceGlyph.arrowUp:
        canvas.drawPath(
          Path()
            ..moveTo(5, 12)
            ..lineTo(12, 5)
            ..lineTo(19, 12),
          stroke,
        );
        canvas.drawLine(const Offset(12, 5), const Offset(12, 19), stroke);
      case WorkspaceGlyph.stop:
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(2, 2, 20, 20),
            const Radius.circular(3),
          ),
          Paint()..color = color,
        );
      case WorkspaceGlyph.settings:
        const corner = Radius.circular(2.34);
        canvas.drawPath(
          Path()
            ..moveTo(9.671, 4.136)
            ..arcToPoint(const Offset(14.33, 4.136), radius: corner)
            ..arcToPoint(
              const Offset(17.649, 6.051),
              radius: corner,
              clockwise: false,
            )
            ..arcToPoint(const Offset(19.979, 10.084), radius: corner)
            ..arcToPoint(
              const Offset(19.979, 13.915),
              radius: corner,
              clockwise: false,
            )
            ..arcToPoint(const Offset(17.649, 17.948), radius: corner)
            ..arcToPoint(
              const Offset(14.33, 19.863),
              radius: corner,
              clockwise: false,
            )
            ..arcToPoint(const Offset(9.671, 19.863), radius: corner)
            ..arcToPoint(
              const Offset(6.351, 17.948),
              radius: corner,
              clockwise: false,
            )
            ..arcToPoint(const Offset(4.021, 13.915), radius: corner)
            ..arcToPoint(
              const Offset(4.021, 10.084),
              radius: corner,
              clockwise: false,
            )
            ..arcToPoint(const Offset(6.35, 6.051), radius: corner)
            ..arcToPoint(
              const Offset(9.669, 4.136),
              radius: corner,
              clockwise: false,
            ),
          stroke,
        );
        canvas.drawCircle(const Offset(12, 12), 3, stroke);
      case WorkspaceGlyph.sliders:
        for (final (x, y, leftEnd, rightStart) in const [
          (14.0, 5.0, 10.0, 14.0),
          (8.0, 12.0, 8.0, 12.0),
          (16.0, 19.0, 12.0, 16.0),
        ]) {
          canvas.drawLine(Offset(3, y), Offset(leftEnd, y), stroke);
          canvas.drawLine(Offset(rightStart, y), Offset(21, y), stroke);
          canvas.drawLine(Offset(x, y - 2), Offset(x, y + 2), stroke);
        }
      case WorkspaceGlyph.plus:
        canvas.drawLine(const Offset(5, 12), const Offset(19, 12), stroke);
        canvas.drawLine(const Offset(12, 5), const Offset(12, 19), stroke);
      case WorkspaceGlyph.close:
        canvas.drawLine(const Offset(18, 6), const Offset(6, 18), stroke);
        canvas.drawLine(const Offset(6, 6), const Offset(18, 18), stroke);
      case WorkspaceGlyph.pin || WorkspaceGlyph.pinOff:
        const corner = Radius.circular(2);
        const bend = Radius.circular(1);
        final off = glyph == WorkspaceGlyph.pinOff;
        canvas.drawLine(const Offset(12, 17), const Offset(12, 22), stroke);
        final body = Path()
          ..moveTo(9, off ? 9 : 10.76)
          ..lineTo(9, 10.76)
          ..arcToPoint(const Offset(7.89, 12.55), radius: corner)
          ..lineTo(6.11, 13.45)
          ..arcToPoint(const Offset(5, 15.24), radius: corner, clockwise: false)
          ..lineTo(5, 16)
          ..arcToPoint(const Offset(6, 17), radius: bend, clockwise: false);
        if (off) {
          body
            ..lineTo(17, 17)
            ..moveTo(15, 9.34)
            ..lineTo(15, 7)
            ..arcToPoint(const Offset(16, 6), radius: bend)
            ..arcToPoint(const Offset(16, 2), radius: corner, clockwise: false)
            ..lineTo(7.89, 2)
            ..moveTo(2, 2)
            ..lineTo(22, 22);
        } else {
          body
            ..lineTo(18, 17)
            ..arcToPoint(const Offset(19, 16), radius: bend, clockwise: false)
            ..lineTo(19, 15.24)
            ..arcToPoint(
              const Offset(17.89, 13.45),
              radius: corner,
              clockwise: false,
            )
            ..lineTo(16.11, 12.55)
            ..arcToPoint(const Offset(15, 10.76), radius: corner)
            ..lineTo(15, 7)
            ..arcToPoint(const Offset(16, 6), radius: bend)
            ..arcToPoint(const Offset(16, 2), radius: corner, clockwise: false)
            ..lineTo(8, 2)
            ..arcToPoint(const Offset(8, 6), radius: corner, clockwise: false)
            ..arcToPoint(const Offset(9, 7), radius: bend)
            ..close();
        }
        canvas.drawPath(body, stroke);
      case WorkspaceGlyph.mail:
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(2, 4, 20, 16),
            const Radius.circular(2),
          ),
          stroke,
        );
        canvas.drawPath(
          Path()
            ..moveTo(22, 7)
            ..lineTo(13.009, 12.727)
            ..arcToPoint(
              const Offset(11, 12.727),
              radius: const Radius.circular(2),
            )
            ..lineTo(2, 7),
          stroke,
        );
      case WorkspaceGlyph.mailOpen:
        const corner = Radius.circular(2);
        canvas.drawPath(
          Path()
            ..moveTo(21.2, 8.4)
            ..cubicTo(21.7, 8.78, 22, 9.37, 22, 10)
            ..lineTo(22, 20)
            ..arcToPoint(const Offset(20, 22), radius: corner)
            ..lineTo(4, 22)
            ..arcToPoint(const Offset(2, 20), radius: corner)
            ..lineTo(2, 10)
            ..arcToPoint(const Offset(2.8, 8.4), radius: corner)
            ..lineTo(10.8, 2.4)
            ..arcToPoint(const Offset(13.2, 2.4), radius: corner)
            ..close()
            ..moveTo(22, 10)
            ..lineTo(13.03, 15.7)
            ..arcToPoint(
              const Offset(10.97, 15.7),
              radius: const Radius.circular(1.94),
            )
            ..lineTo(2, 10),
          stroke,
        );
      case WorkspaceGlyph.archive || WorkspaceGlyph.archiveRestore:
        final restoring = glyph == WorkspaceGlyph.archiveRestore;
        const corner = Radius.circular(2);
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(2, 3, 20, 5),
            const Radius.circular(1),
          ),
          stroke,
        );
        final box = Path()
          ..moveTo(4, 8)
          ..lineTo(4, 19)
          ..arcToPoint(const Offset(6, 21), radius: corner, clockwise: false);
        if (restoring) {
          box
            ..lineTo(8, 21)
            ..moveTo(20, 8)
            ..lineTo(20, 19)
            ..arcToPoint(const Offset(18, 21), radius: corner)
            ..lineTo(16, 21)
            ..moveTo(9, 15)
            ..lineTo(12, 12)
            ..lineTo(15, 15)
            ..moveTo(12, 12)
            ..lineTo(12, 21);
        } else {
          box
            ..lineTo(18, 21)
            ..arcToPoint(const Offset(20, 19), radius: corner, clockwise: false)
            ..lineTo(20, 8)
            ..moveTo(10, 12)
            ..lineTo(14, 12);
        }
        canvas.drawPath(box, stroke);
      case WorkspaceGlyph.search:
        canvas.drawCircle(const Offset(11, 11), 8, stroke);
        canvas.drawLine(
          const Offset(21, 21),
          const Offset(16.66, 16.66),
          stroke,
        );
      case WorkspaceGlyph.copy:
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(8, 8, 14, 14),
            const Radius.circular(2),
          ),
          stroke,
        );
        canvas.drawPath(
          Path()
            ..moveTo(4, 16)
            ..cubicTo(2.9, 16, 2, 15.1, 2, 14)
            ..lineTo(2, 4)
            ..cubicTo(2, 2.9, 2.9, 2, 4, 2)
            ..lineTo(14, 2)
            ..cubicTo(15.1, 2, 16, 2.9, 16, 4),
          stroke,
        );
      case WorkspaceGlyph.hand:
        const corner = Radius.circular(2);
        canvas.drawPath(
          Path()
            ..moveTo(18, 11)
            ..lineTo(18, 6)
            ..arcToPoint(const Offset(16, 4), radius: corner, clockwise: false)
            ..arcToPoint(const Offset(14, 6), radius: corner, clockwise: false)
            ..moveTo(14, 10)
            ..lineTo(14, 4)
            ..arcToPoint(const Offset(12, 2), radius: corner, clockwise: false)
            ..arcToPoint(const Offset(10, 4), radius: corner, clockwise: false)
            ..lineTo(10, 6)
            ..moveTo(10, 10.5)
            ..lineTo(10, 6)
            ..arcToPoint(const Offset(8, 4), radius: corner, clockwise: false)
            ..arcToPoint(const Offset(6, 6), radius: corner, clockwise: false)
            ..lineTo(6, 14)
            ..moveTo(18, 8)
            ..arcToPoint(const Offset(22, 8), radius: corner, largeArc: true)
            ..lineTo(22, 14)
            ..arcToPoint(const Offset(14, 22), radius: const Radius.circular(8))
            ..lineTo(12, 22)
            ..cubicTo(9.2, 22, 7.5, 21.14, 6.01, 19.66)
            ..lineTo(2.41, 16.06)
            ..arcToPoint(const Offset(5.24, 13.24), radius: corner)
            ..lineTo(7, 15),
          stroke,
        );
      case WorkspaceGlyph.question || WorkspaceGlyph.questionCircle:
        if (glyph == WorkspaceGlyph.questionCircle) {
          canvas.drawCircle(const Offset(12, 12), 10, stroke);
        } else {
          canvas.drawPath(
            Path()
              ..moveTo(2.992, 16.342)
              ..arcToPoint(
                const Offset(3.086, 17.509),
                radius: const Radius.circular(2),
              )
              ..lineTo(2.021, 20.799)
              ..arcToPoint(
                const Offset(3.257, 21.967),
                radius: const Radius.circular(1),
                clockwise: false,
              )
              ..lineTo(6.67, 20.969)
              ..arcToPoint(
                const Offset(7.769, 21.061),
                radius: const Radius.circular(2),
              )
              ..arcToPoint(
                const Offset(2.992, 16.342),
                radius: const Radius.circular(10),
                largeArc: true,
                clockwise: false,
              ),
            stroke,
          );
        }
        canvas.drawPath(
          Path()
            ..moveTo(9.09, 9)
            ..arcToPoint(
              const Offset(14.92, 10),
              radius: const Radius.circular(3),
            )
            ..cubicTo(14.92, 12, 11.92, 13, 11.92, 13),
          stroke,
        );
        canvas.drawLine(const Offset(12, 17), const Offset(12.01, 17), stroke);
      case WorkspaceGlyph.star || WorkspaceGlyph.starFilled:
        final starPath = Path()
          ..moveTo(12, 2.5)
          ..lineTo(14.92, 8.42)
          ..lineTo(21.45, 9.37)
          ..lineTo(16.72, 13.98)
          ..lineTo(17.84, 20.48)
          ..lineTo(12, 17.41)
          ..lineTo(6.16, 20.48)
          ..lineTo(7.28, 13.98)
          ..lineTo(2.55, 9.37)
          ..lineTo(9.08, 8.42)
          ..close();
        if (glyph == WorkspaceGlyph.starFilled) {
          canvas.drawPath(starPath, Paint()..color = color);
        } else {
          canvas.drawPath(starPath, stroke);
        }
      case WorkspaceGlyph.zap || WorkspaceGlyph.zapFilled:
        final zapPath = Path()
          ..moveTo(13, 2)
          ..lineTo(4, 14)
          ..lineTo(11, 14)
          ..lineTo(10, 22)
          ..lineTo(20, 10)
          ..lineTo(13, 10)
          ..close();
        if (glyph == WorkspaceGlyph.zapFilled) {
          canvas.drawPath(zapPath, Paint()..color = color);
        } else {
          canvas.drawPath(zapPath, stroke);
        }
      case WorkspaceGlyph.workflow:
        const boxRadius = Radius.circular(2);
        canvas.drawRRect(
          RRect.fromRectAndRadius(const Rect.fromLTWH(3, 3, 8, 8), boxRadius),
          stroke,
        );
        canvas.drawRRect(
          RRect.fromRectAndRadius(const Rect.fromLTWH(13, 13, 8, 8), boxRadius),
          stroke,
        );
        canvas.drawPath(
          Path()
            ..moveTo(7, 11)
            ..lineTo(7, 15)
            ..arcToPoint(
              const Offset(9, 17),
              radius: boxRadius,
              clockwise: false,
            )
            ..lineTo(13, 17),
          stroke,
        );
      case WorkspaceGlyph.listChecks:
        canvas.drawPath(
          Path()
            ..moveTo(3, 7)
            ..lineTo(5, 9)
            ..lineTo(9, 5)
            ..moveTo(3, 17)
            ..lineTo(5, 19)
            ..lineTo(9, 15),
          stroke,
        );
        canvas.drawLine(const Offset(13, 7), const Offset(21, 7), stroke);
        canvas.drawLine(const Offset(13, 12), const Offset(21, 12), stroke);
        canvas.drawLine(const Offset(13, 17), const Offset(21, 17), stroke);
      case WorkspaceGlyph.bot:
        canvas.drawLine(const Offset(12, 8), const Offset(12, 4), stroke);
        canvas.drawLine(const Offset(8, 4), const Offset(12, 4), stroke);
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(4, 8, 16, 12),
            const Radius.circular(2),
          ),
          stroke,
        );
        canvas.drawLine(const Offset(2, 14), const Offset(4, 14), stroke);
        canvas.drawLine(const Offset(20, 14), const Offset(22, 14), stroke);
        canvas.drawLine(const Offset(9, 13), const Offset(9, 15), stroke);
        canvas.drawLine(const Offset(15, 13), const Offset(15, 15), stroke);
      case WorkspaceGlyph.sparkles:
        canvas.drawPath(
          Path()
            ..moveTo(11, 3)
            ..quadraticBezierTo(11, 10, 18, 10)
            ..quadraticBezierTo(11, 10, 11, 17)
            ..quadraticBezierTo(11, 10, 4, 10)
            ..quadraticBezierTo(11, 10, 11, 3)
            ..close(),
          stroke,
        );
        canvas.drawLine(const Offset(19, 15), const Offset(19, 21), stroke);
        canvas.drawLine(const Offset(16, 18), const Offset(22, 18), stroke);
        canvas.drawLine(const Offset(5, 18), const Offset(5, 20), stroke);
        canvas.drawLine(const Offset(4, 19), const Offset(6, 19), stroke);
      case WorkspaceGlyph.shieldAlert:
        canvas.drawPath(
          Path()
            ..moveTo(12, 2.5)
            ..lineTo(19, 5.5)
            ..lineTo(19, 11.5)
            ..cubicTo(19, 16.5, 15.8, 19.9, 12, 21.5)
            ..cubicTo(8.2, 19.9, 5, 16.5, 5, 11.5)
            ..lineTo(5, 5.5)
            ..close(),
          stroke,
        );
        canvas.drawLine(const Offset(12, 8.5), const Offset(12, 12.5), stroke);
        canvas.drawLine(const Offset(12, 16), const Offset(12.01, 16), stroke);
      case WorkspaceGlyph.check:
        canvas.drawPath(
          Path()
            ..moveTo(5, 12.5)
            ..lineTo(9.5, 17)
            ..lineTo(19, 7.5),
          stroke,
        );
      case WorkspaceGlyph.lock:
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(4, 11, 16, 10),
            const Radius.circular(2),
          ),
          stroke,
        );
        canvas.drawPath(
          Path()
            ..moveTo(7, 11)
            ..lineTo(7, 7)
            ..arcToPoint(
              const Offset(17, 7),
              radius: const Radius.circular(5),
            )
            ..lineTo(17, 11),
          stroke,
        );
      case WorkspaceGlyph.atSign:
        canvas.drawCircle(const Offset(12, 12), 4, stroke);
        canvas.drawPath(
          Path()
            ..moveTo(16, 8)
            ..lineTo(16, 13)
            ..arcToPoint(
              const Offset(22, 13),
              radius: const Radius.circular(3),
              clockwise: false,
            )
            ..lineTo(22, 12)
            ..arcToPoint(
              const Offset(18, 20),
              radius: const Radius.circular(10),
              largeArc: true,
              clockwise: false,
            ),
          stroke,
        );
      case WorkspaceGlyph.slash:
        canvas.drawLine(const Offset(17, 4), const Offset(7, 20), stroke);
      case WorkspaceGlyph.messagesSquare:
        const corner = Radius.circular(2);
        canvas.drawPath(
          Path()
            ..moveTo(14, 9)
            ..arcToPoint(const Offset(12, 11), radius: corner)
            ..lineTo(6, 11)
            ..lineTo(2, 15)
            ..lineTo(2, 4)
            ..arcToPoint(const Offset(4, 2), radius: corner)
            ..lineTo(12, 2)
            ..arcToPoint(const Offset(14, 4), radius: corner)
            ..close(),
          stroke,
        );
        canvas.drawPath(
          Path()
            ..moveTo(18, 9)
            ..lineTo(20, 9)
            ..arcToPoint(const Offset(22, 11), radius: corner)
            ..lineTo(22, 22)
            ..lineTo(18, 18)
            ..lineTo(12, 18)
            ..arcToPoint(const Offset(10, 16), radius: corner)
            ..lineTo(10, 15),
          stroke,
        );
      case WorkspaceGlyph.dollarSign:
        canvas.drawLine(const Offset(12, 2), const Offset(12, 22), stroke);
        canvas.drawPath(
          Path()
            ..moveTo(17, 5)
            ..lineTo(9.5, 5)
            ..arcToPoint(
              const Offset(9.5, 12),
              radius: const Radius.circular(3.5),
              clockwise: false,
            )
            ..lineTo(14.5, 12)
            ..arcToPoint(
              const Offset(14.5, 19),
              radius: const Radius.circular(3.5),
            )
            ..lineTo(6, 19),
          stroke,
        );
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_WorkspaceIconPainter oldDelegate) =>
      oldDelegate.glyph != glyph || oldDelegate.color != color;
}
