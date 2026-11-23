FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90 AS guardian-builder
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
COPY src/server/subprocess/guardian.c /build/guardian.c
RUN cc -std=c11 -O2 -Wall -Wextra -Werror /build/guardian.c -o /build/may-be-guardian

FROM mcr.microsoft.com/playwright:v1.65.0-noble@sha256:6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d
COPY --from=node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90 /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg flac util-linux pulseaudio tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
RUN mkdir -p /private/mail /private/media /private/native /private/service && chmod 700 /private/*
COPY --from=guardian-builder --chmod=0755 /build/may-be-guardian /usr/local/libexec/may-be-guardian
ENV NEXT_TELEMETRY_DISABLED=1
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
