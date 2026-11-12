#!/usr/bin/env bash
# Headless Blender 5.x GPU render test (Grease Pencil v3 + EEVEE) for Ubuntu 22.04/24.04 + NVIDIA.
#
#   bash run_on_gpu.sh                 # full test (48 frames per scene)
#   FRAMES=4 bash run_on_gpu.sh        # quick smoke test
#   RUN_ALL=1 bash run_on_gpu.sh       # try every render mode even after one passes
#   BLENDER_VERSION=5.3.0 bash run_on_gpu.sh
#
# Render modes tried in order (stops at the first PASS that used the NVIDIA GPU, unless RUN_ALL=1):
#   1. plain   : blender -b                      (default OpenGL backend, headless EGL)
#   2. vulkan  : blender -b --gpu-backend vulkan  (headless Vulkan)
#   3. xvfb    : xvfb-run blender -b              (virtual X server; NOTE usually Mesa software GL)
#
# Output: ./render-results/ and ./render-results-<host>-<time>.tar.gz (plus a small *-sendback.tar.gz)

set -u
cd "$(dirname "$0")"
HERE="$(pwd)"

BLENDER_VERSION="${BLENDER_VERSION:-5.2.4}"
# sha256 from https://download.blender.org/release/Blender5.2/blender-5.2.4.sha256
BLENDER_SHA256_524="2fd14c50987426897ba60237ee996edf2b4151f4b1a72a460ca20be58c1d2d86"
FRAMES="${FRAMES:-48}"
SAMPLES="${SAMPLES:-16}"
RUN_ALL="${RUN_ALL:-0}"
ATTEMPT_TIMEOUT="${ATTEMPT_TIMEOUT:-3600}"

MAJMIN="$(echo "$BLENDER_VERSION" | cut -d. -f1,2)"
TARBALL="blender-${BLENDER_VERSION}-linux-x64.tar.xz"
URL="https://download.blender.org/release/Blender${MAJMIN}/${TARBALL}"
BL_DIR="$HERE/blender-${BLENDER_VERSION}-linux-x64"
BLENDER="$BL_DIR/blender"
RES="$HERE/render-results"
mkdir -p "$RES"
SUMMARY="$RES/summary.txt"
: > "$SUMMARY"

say()  { echo -e "\n\033[1;36m==> $*\033[0m"; }
note() { echo "$*" | tee -a "$SUMMARY"; }

SUDO=""
if [ "$(id -u)" != "0" ]; then SUDO="sudo"; fi

# ------------------------------------------------------------------ 1. system info
say "System info"
{
  echo "date: $(date -u +%FT%TZ)"
  echo "host: $(hostname)"
  . /etc/os-release 2>/dev/null && echo "os: $PRETTY_NAME"
  echo "kernel: $(uname -r)"
  echo "NVIDIA_VISIBLE_DEVICES=${NVIDIA_VISIBLE_DEVICES:-<unset>}"
  echo "NVIDIA_DRIVER_CAPABILITIES=${NVIDIA_DRIVER_CAPABILITIES:-<unset>}"
  echo "DISPLAY=${DISPLAY:-<unset>}"
} | tee "$RES/system.txt"

say "nvidia-smi"
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi 2>&1 | tee "$RES/nvidia-smi.txt"
  nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>&1 | tee -a "$RES/system.txt"
else
  note "WARNING: nvidia-smi not found - is this a GPU instance?"
fi

# ------------------------------------------------------------------ 2. packages
say "Installing minimal headless libraries (apt)"
PKGS="ca-certificates wget xz-utils libegl1 libgl1 libglx0 libopengl0 libgles2 libvulkan1 \
libxi6 libxkbcommon0 libxkbcommon-x11-0 libxrender1 libsm6 libice6 libxext6 libx11-6 libxfixes3 \
libxxf86vm1 libxrandr2 libxinerama1 libxcursor1 libx11-xcb1 libxcb1 libdbus-1-3 libfontconfig1 \
libfreetype6 libwayland-client0 libwayland-egl1 libwayland-cursor0 libdecor-0-0 libtinfo6 \
xvfb xauth ffmpeg"
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -qq >/dev/null 2>&1 || note "WARNING: apt-get update failed"
if ! $SUDO apt-get install -y -qq --no-install-recommends $PKGS >"$RES/apt.log" 2>&1; then
  echo "bulk install failed, installing one by one (missing ones are skipped)"
  for p in $PKGS; do
    $SUDO apt-get install -y -qq --no-install-recommends "$p" >>"$RES/apt.log" 2>&1 || echo "  skipped: $p" | tee -a "$RES/apt.log"
  done
fi

# ------------------------------------------------------------------ 3. NVIDIA graphics libs check
say "Checking NVIDIA graphics (EGL/Vulkan) userspace libraries"
ldconfig -p 2>/dev/null | grep -E 'libEGL_nvidia|libGLX_nvidia|libnvidia-glcore|libnvidia-eglcore' | tee "$RES/nvidia-libs.txt"
if ! grep -q libEGL_nvidia "$RES/nvidia-libs.txt"; then
  note "WARNING: libEGL_nvidia.so not found. The container only has CUDA ('compute,utility') driver libs."
  note "         GPU EEVEE needs graphics libs: recreate the instance with env var NVIDIA_DRIVER_CAPABILITIES=all"
  note "         (RunPod: template/pod env vars; Vast: add '-e NVIDIA_DRIVER_CAPABILITIES=all' to docker options)."
fi
# glvnd needs a vendor json to find libEGL_nvidia; containers sometimes mount the lib but not the json.
if grep -q libEGL_nvidia "$RES/nvidia-libs.txt"; then
  if ! ls /usr/share/glvnd/egl_vendor.d/*nvidia*.json >/dev/null 2>&1; then
    echo "creating /usr/share/glvnd/egl_vendor.d/10_nvidia.json"
    $SUDO mkdir -p /usr/share/glvnd/egl_vendor.d
    echo '{"file_format_version":"1.0.0","ICD":{"library_path":"libEGL_nvidia.so.0"}}' | $SUDO tee /usr/share/glvnd/egl_vendor.d/10_nvidia.json >/dev/null
    note "created missing glvnd EGL vendor file for NVIDIA"
  fi
fi
if grep -q libGLX_nvidia "$RES/nvidia-libs.txt"; then
  if ! ls /usr/share/vulkan/icd.d/nvidia_icd*.json /etc/vulkan/icd.d/nvidia_icd*.json >/dev/null 2>&1; then
    echo "creating /usr/share/vulkan/icd.d/nvidia_icd.json"
    $SUDO mkdir -p /usr/share/vulkan/icd.d
    echo '{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3.0"}}' | $SUDO tee /usr/share/vulkan/icd.d/nvidia_icd.json >/dev/null
    note "created missing Vulkan ICD file for NVIDIA"
  fi
fi
ls -l /usr/share/glvnd/egl_vendor.d/ /usr/share/vulkan/icd.d/ /etc/vulkan/icd.d/ 2>/dev/null >> "$RES/nvidia-libs.txt"

# ------------------------------------------------------------------ 4. Blender download
say "Blender $BLENDER_VERSION"
if [ ! -x "$BLENDER" ]; then
  if [ ! -f "$TARBALL" ]; then
    echo "downloading $URL (~380 MB)"
    wget -q --show-progress -O "$TARBALL.part" "$URL" || { note "FATAL: download failed: $URL"; exit 1; }
    mv "$TARBALL.part" "$TARBALL"
  fi
  if [ "$BLENDER_VERSION" = "5.2.4" ]; then
    echo "$BLENDER_SHA256_524  $TARBALL" | sha256sum -c - || { note "FATAL: sha256 mismatch for $TARBALL"; rm -f "$TARBALL"; exit 1; }
  else
    wget -q -O "blender-${BLENDER_VERSION}.sha256" "https://download.blender.org/release/Blender${MAJMIN}/blender-${BLENDER_VERSION}.sha256" \
      && grep "$TARBALL" "blender-${BLENDER_VERSION}.sha256" | sha256sum -c - \
      || note "WARNING: could not verify sha256 for $TARBALL"
  fi
  echo "extracting..."
  tar -xf "$TARBALL" || { note "FATAL: extract failed"; exit 1; }
fi
"$BLENDER" --version 2>&1 | head -3 | tee "$RES/blender-version.txt"
echo "missing shared libs (should be empty):" | tee "$RES/ldd-missing.txt"
ldd "$BLENDER" 2>/dev/null | grep "not found" | tee -a "$RES/ldd-missing.txt"

# ------------------------------------------------------------------ 5. render attempts
run_attempt() {  # name, then command prefix words; blender args appended
  local name="$1"; shift
  local out="$RES/$name"
  rm -rf "$out"; mkdir -p "$out"
  say "Render attempt: $name"
  local t0=$(date +%s)
  RENDER_ATTEMPT="$name" timeout "$ATTEMPT_TIMEOUT" "$@" \
      --python-exit-code 3 --python "$HERE/scene_test.py" -- \
      --out "$out" --frames "$FRAMES" --samples "$SAMPLES" > "$out/blender.log" 2>&1
  local rc=$?
  local t1=$(date +%s)
  local verdict="FAIL"
  if [ -f "$out/report.json" ] && grep -q '"overall_pass": true' "$out/report.json"; then
    if grep -q '"nvidia_gpu_used": true' "$out/report.json"; then verdict="PASS_GPU"; else verdict="PASS_NOT_NVIDIA"; fi
  fi
  local renderer
  renderer=$(grep '"renderer"' "$out/report.json" 2>/dev/null | tail -n1 | sed 's/^ *//')
  note "attempt=$name exit=$rc wall=$((t1-t0))s verdict=$verdict ${renderer}"
  if [ "$verdict" = "FAIL" ]; then
    echo "--- last 40 log lines ($out/blender.log) ---"; tail -n 40 "$out/blender.log"
  else
    grep -E 'RESULT|frame 1/|GPU \(' "$out/blender.log" | head -8
  fi
  # mp4s
  if command -v ffmpeg >/dev/null 2>&1; then
    for sc in gp eevee; do
      if ls "$out/$sc"/frame_*.png >/dev/null 2>&1; then
        ffmpeg -y -loglevel error -framerate 24 -i "$out/$sc/frame_%04d.png" \
          -c:v libx264 -pix_fmt yuv420p -crf 18 "$out/${sc}.mp4" && echo "made $out/${sc}.mp4"
      fi
    done
  fi
  LAST_VERDICT="$verdict"
}

BL_ARGS=(-b --factory-startup)
LAST_VERDICT="FAIL"; WORKED=""

run_attempt plain env -u DISPLAY -u WAYLAND_DISPLAY "$BLENDER" "${BL_ARGS[@]}"
[ "$LAST_VERDICT" = "PASS_GPU" ] && WORKED="${WORKED} plain"

if [ -z "$WORKED" ] || [ "$RUN_ALL" = "1" ]; then
  run_attempt vulkan env -u DISPLAY -u WAYLAND_DISPLAY "$BLENDER" "${BL_ARGS[@]}" --gpu-backend vulkan
  [ "$LAST_VERDICT" = "PASS_GPU" ] && WORKED="${WORKED} vulkan"
fi

if [ -z "$WORKED" ] || [ "$RUN_ALL" = "1" ]; then
  if command -v xvfb-run >/dev/null 2>&1; then
    run_attempt xvfb xvfb-run -a -s "-screen 0 1920x1080x24 +extension GLX" "$BLENDER" "${BL_ARGS[@]}"
    [ "$LAST_VERDICT" != "FAIL" ] && WORKED="${WORKED} xvfb(${LAST_VERDICT})"
  else
    note "xvfb-run not available, skipping xvfb attempt"
  fi
fi

# ------------------------------------------------------------------ 6. summary + tar
say "SUMMARY"
if [ -n "$WORKED" ]; then note "WORKING MODES:${WORKED}"; else note "NO MODE PASSED - send back the sendback tarball"; fi
cat "$SUMMARY"

STAMP="$(hostname)-$(date -u +%Y%m%dT%H%M%SZ)"
FULL="$HERE/render-results-${STAMP}.tar.gz"
SMALL="$HERE/render-results-${STAMP}-sendback.tar.gz"
tar -czf "$FULL" -C "$HERE" render-results
# small bundle: reports, logs, mp4s, first+middle frame of each scene
( cd "$HERE" && find render-results -maxdepth 1 -type f;
  find render-results -name 'report.json' -o -name 'blender.log' -o -name '*.mp4' \
       -o -name 'frame_0001.png' -o -name 'frame_0024.png' ) | sort -u > "$RES/.sendback_list"
tar -czf "$SMALL" -C "$HERE" -T "$RES/.sendback_list"
echo
echo "Full results : $FULL ($(du -h "$FULL" | cut -f1))"
echo "Send back    : $SMALL ($(du -h "$SMALL" | cut -f1))"
