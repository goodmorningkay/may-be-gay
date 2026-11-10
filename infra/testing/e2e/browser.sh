#!/usr/bin/env bash
set -euo pipefail
# Real decoded audio needs an output clock in Firefox. No host sound device or
# TCP listener: this container owns a silent PulseAudio sink and Unix socket.
if ! pulseaudio --system --daemonize=yes --disallow-exit --exit-idle-time=-1 -n \
  --load='module-native-protocol-unix auth-anonymous=1 socket=/tmp/e2e-pulse.sock' \
  --load='module-null-sink sink_name=acceptance' 2>/tmp/e2e-pulse.log; then
  cat /tmp/e2e-pulse.log >&2
  exit 1
fi
export PULSE_SERVER=unix:/tmp/e2e-pulse.sock
exec "$@"
