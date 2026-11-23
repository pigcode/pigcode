#!/bin/sh
set -eu

mobile_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fonts_dir=$(mktemp -d "${TMPDIR:-/tmp}/pigcode-visual-fonts.XXXXXX")
trap 'rm -rf "$fonts_dir"' EXIT

font_file="$fonts_dir/NotoSansSC.ttf"
curl --fail --silent --show-error --location --retry 3 --output "$font_file" \
  'https://raw.githubusercontent.com/google/fonts/2894aab31764f10f29c421bdfd2340d3b382d384/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf'
printf '%s  %s\n' a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da "$font_file" | shasum -a 256 -c

cd "$mobile_dir/app"
TZ=UTC PIGCODE_MOBILE_GOLDEN_FONT="$font_file" \
  flutter test --no-pub visual/mobile_golden_test.dart "$@"
