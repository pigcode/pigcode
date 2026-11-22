#!/bin/sh
set -eu

mobile_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
required=$(cat "$mobile_dir/.flutter-version")
actual=$(flutter --version --machine | node -p 'JSON.parse(require("node:fs").readFileSync(0)).frameworkVersion')
if [ "$actual" != "$required" ]; then
  printf '需要 Flutter %s，当前为 %s\n' "$required" "$actual" >&2
  exit 1
fi

product=$(node -p 'require(process.argv[1]).version' "$mobile_dir/../desktop/package.json")
build_name=$(printf '%s' "$product" | cut -d- -f1 | cut -d+ -f1)
build_number=${PIGCODE_MOBILE_BUILD_NUMBER:-1}
case "$build_number" in
  0|''|*[!0-9]*) printf 'PIGCODE_MOBILE_BUILD_NUMBER 必须为正整数\n' >&2; exit 1 ;;
esac

cd "$mobile_dir/app"
exec flutter "$@" \
  --build-name "$build_name" \
  --build-number "$build_number" \
  --dart-define "PIGCODE_PRODUCT_VERSION=$product"
