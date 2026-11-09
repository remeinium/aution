#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Builds the signed release APK: artifacts/android/aution-<version>.apk (and aution.apk, the name the download link uses).
#
# Signing comes from outside the repository (see src-tauri/gen/android/app/build.gradle.kts):
#   AUTION_SIGNING_PROPERTIES=/path/to/release.properties   (default: ~/.config/aution/release.properties if it exists)
#   or AUTION_KEYSTORE_FILE + AUTION_KEYSTORE_PASSWORD (+ AUTION_KEY_ALIAS, AUTION_KEY_PASSWORD), as in CI.
# Nothing secret is printed. Without signing values the build stops, so an unsigned APK is never published by mistake.
#
# CPU types: arm64 (every phone of the last decade) and armv7 (older phones). x86 is left out: emulators and a few
# Chromebooks only, and each CPU type adds the whole native library again.
set -euo pipefail

cd "$(dirname "$0")/../.."
if [[ -z "${AUTION_SIGNING_PROPERTIES:-}" && -z "${AUTION_KEYSTORE_FILE:-}" && -f "$HOME/.config/aution/release.properties" ]]; then
  export AUTION_SIGNING_PROPERTIES="$HOME/.config/aution/release.properties"
fi
if [[ -z "${AUTION_SIGNING_PROPERTIES:-}" && -z "${AUTION_KEYSTORE_FILE:-}" ]]; then
  echo "No signing key: set AUTION_SIGNING_PROPERTIES or AUTION_KEYSTORE_FILE (see docs/mobile.md, Release)." >&2
  exit 1
fi

version=$(node -p "require('./package.json').version")
npx tauri android build --apk --target aarch64 --target armv7 --ci

apk=src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
build_tools=$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/build-tools/*/ | sort -V | tail -1)
"$build_tools/apksigner" verify --print-certs "$apk" | grep -E "SHA-256 digest|Signer #1 certificate DN"

mkdir -p artifacts/android
cp "$apk" "artifacts/android/aution-$version.apk"
cp "$apk" artifacts/android/aution.apk
ls -l artifacts/android/aution-"$version".apk
