#!/usr/bin/env bash
# Regression test for the unified universal nightly macOS track.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKFLOW_FILE="$ROOT_DIR/.github/workflows/nightly.yml"

if ! grep -Fq "cancel-in-progress: \${{ github.event_name == 'push' }}" "$WORKFLOW_FILE"; then
  echo "FAIL: nightly workflow must cancel stale push runs while leaving manual runs queued"
  exit 1
fi

if ! awk '
  /^      - name: Build universal nightly app \(Release\)/ { in_universal=1; next }
  in_universal && /^      - name:/ { in_universal=0 }
  in_universal && /-destination '\''generic\/platform=macOS'\''/ { saw_universal_destination=1 }
  in_universal && /ARCHS="arm64 x86_64"/ { saw_universal_archs=1 }
  in_universal && /ONLY_ACTIVE_ARCH=NO/ { saw_universal_only_active_arch=1 }
  END {
    exit !(saw_universal_destination && saw_universal_archs && saw_universal_only_active_arch)
  }
' "$WORKFLOW_FILE"; then
  echo "FAIL: nightly workflow must build the unified nightly app as a universal binary"
  exit 1
fi

if ! awk '
  /^      - name: Verify nightly binary architectures/ { in_verify=1; next }
  in_verify && /^      - name:/ { in_verify=0 }
  in_verify && /lipo -archs "\$APP_BINARY"/ { saw_app=1 }
  in_verify && /lipo -archs "\$CLI_BINARY"/ { saw_cli=1 }
  in_verify && /lipo -archs "\$HELPER_BINARY"/ { saw_helper=1 }
  in_verify && /\[\[ "\$APP_ARCHS" == \*arm64\* && "\$APP_ARCHS" == \*x86_64\* \]\]/ { saw_app_assert=1 }
  in_verify && /\[\[ "\$CLI_ARCHS" == \*arm64\* && "\$CLI_ARCHS" == \*x86_64\* \]\]/ { saw_cli_assert=1 }
  in_verify && /\[\[ "\$HELPER_ARCHS" == \*arm64\* && "\$HELPER_ARCHS" == \*x86_64\* \]\]/ { saw_helper_assert=1 }
  END { exit !(saw_app && saw_cli && saw_helper && saw_app_assert && saw_cli_assert && saw_helper_assert) }
' "$WORKFLOW_FILE"; then
  echo "FAIL: nightly workflow must verify universal app, CLI, and helper slices with lipo"
  exit 1
fi

if ! grep -Fq 'com.cmuxterm.app.nightly' "$WORKFLOW_FILE"; then
  echo "FAIL: nightly workflow must set the unified nightly bundle ID"
  exit 1
fi

if ! grep -Fq 'https://files.cmux.com/nightly/appcast.xml' "$WORKFLOW_FILE"; then
  echo "FAIL: nightly workflow must point the unified nightly app at the R2 appcast"
  exit 1
fi

if ! grep -Fq './scripts/sparkle_generate_appcast.sh "$NIGHTLY_DMG_IMMUTABLE" nightly appcast.xml' "$WORKFLOW_FILE"; then
  echo "FAIL: nightly workflow must generate the unified nightly appcast"
  exit 1
fi

if ! grep -Fq 'cp appcast.xml appcast-universal.xml' "$WORKFLOW_FILE"; then
  echo "FAIL: nightly workflow must keep the legacy universal appcast alias"
  exit 1
fi

if ! grep -Fq "core.setOutput('should_publish', isMainRef ? 'true' : 'false');" "$WORKFLOW_FILE"; then
  echo "FAIL: nightly decide step must expose should_publish based on whether the ref is main"
  exit 1
fi

if ! awk '
  /^      - name: Upload branch nightly artifacts/ { in_upload=1; next }
  in_upload && /^      - name:/ { in_upload=0 }
  in_upload && /if: needs\.decide\.outputs\.should_publish != '\''true'\''/ { saw_if=1 }
  in_upload && /uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7/ { saw_upload=1 }
  in_upload && /cmux-nightly-macos\*\.dmg/ { saw_artifacts=1 }
  in_upload && /appcast\.xml/ { saw_appcast=1 }
  in_upload && /appcast-universal\.xml/ { saw_universal_appcast=1 }
  END { exit !(saw_if && saw_upload && saw_artifacts && saw_appcast && saw_universal_appcast) }
' "$WORKFLOW_FILE"; then
  echo "FAIL: non-main nightly runs must upload the unified nightly artifacts and appcasts"
  exit 1
fi

if ! awk '
  /^      - name: Move nightly tag to built commit/ { in_move=1; next }
  in_move && /^      - name:/ { in_move=0 }
  in_move && /if: needs\.decide\.outputs\.should_publish == '\''true'\''/ { saw_move_if=1 }
  END { exit !saw_move_if }
' "$WORKFLOW_FILE"; then
  echo "FAIL: moving the nightly tag must be gated to main nightly publishes"
  exit 1
fi

if ! awk '
  /^      - name: Publish nightly release assets/ { in_publish=1; next }
  in_publish && /^      - name:/ { in_publish=0 }
  in_publish && /if: needs\.decide\.outputs\.should_publish == '\''true'\''/ { saw_publish_if=1 }
  in_publish && /cmux-nightly-macos-\$\{\{ github\.run_id \}\}\*\.dmg/ { saw_immutable=1 }
  in_publish && /cmux-nightly-macos\.dmg/ { saw_stable=1 }
  in_publish && /appcast\.xml/ { saw_appcast=1 }
  in_publish && /appcast-universal\.xml/ { saw_universal_appcast=1 }
  END { exit !(saw_publish_if && saw_immutable && saw_stable && saw_appcast && saw_universal_appcast) }
' "$WORKFLOW_FILE"; then
  echo "FAIL: main nightly publish must include the unified nightly assets and appcasts"
  exit 1
fi

echo "PASS: nightly workflow keeps the unified universal nightly track"
