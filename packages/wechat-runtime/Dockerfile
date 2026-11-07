FROM docker.io/oven/bun:1.3.14 AS client
# Keep the large, read-only client independent of application source and dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends squashfs-tools \
    && rm -rf /var/lib/apt/lists/*
ARG WECHAT_APPIMAGE_URL=https://github.com/yamada-sexta/matrix-wechat/releases/download/wechat-client-4.1.13-4526180b/WeChatLinux_x86_64.AppImage
COPY packages/wechat-runtime/scripts/download-client.ts /tmp/download-client.ts
COPY packages/wechat-native/src/storage_profile.toml /tmp/storage_profile.toml
RUN bun /tmp/download-client.ts "$WECHAT_APPIMAGE_URL" /opt/wechat-client/WeChatLinux_x86_64.AppImage /tmp/storage_profile.toml /opt/wechat-client/app \
    && chmod -R a+rX,a-w /opt/wechat-client

FROM docker.io/oven/bun:1.3.14 AS native-build
RUN apt-get update && apt-get install -y --no-install-recommends g++ libsqlite3-dev locales \
    && localedef -i de_DE -f UTF-8 de_DE.UTF-8 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=client /opt/wechat-client/app/opt/wechat/libowl.so /opt/native/libowl.so
WORKDIR /opt/native
COPY packages/wechat-native/native/ ./native/
COPY packages/wechat-native/tests/ ./tests/
COPY packages/wechat-native/scripts/build-native.sh ./scripts/
COPY packages/wechat-runtime/scripts/verify-native-query.ts /opt/wechat-runtime/scripts/
RUN bash scripts/build-native.sh /opt/native /opt/native

FROM docker.io/oven/bun:1.3.14 AS build
WORKDIR /opt/matrix-wechat
# Frida's npm install script invokes `node`; Bun provides that executable here.
RUN ln -sf /usr/local/bin/bun /usr/local/bin/node
COPY package.json bun.lock ./
COPY packages/wechat-runtime/package.json ./packages/wechat-runtime/package.json
COPY packages/wechat-native/package.json ./packages/wechat-native/package.json
COPY packages/wechat-rpc/package.json ./packages/wechat-rpc/package.json
COPY packages/matrix-bridge/package.json ./packages/matrix-bridge/package.json
RUN bun install --frozen-lockfile --filter wechat-runtime --filter wechat-rpc --filter wechat-native
RUN cd packages/wechat-runtime && bun -e 'const f=await import("frida");await f.getLocalDevice();console.log("Frida binding works under Bun")'
COPY .gitignore ./
COPY packages/wechat-rpc ./packages/wechat-rpc
COPY packages/wechat-runtime ./packages/wechat-runtime
COPY packages/wechat-native ./packages/wechat-native
RUN bun run --cwd packages/wechat-native check && bun run --cwd packages/wechat-native lint
RUN bun run --cwd packages/wechat-rpc check && bun run --cwd packages/wechat-rpc lint
WORKDIR /opt/matrix-wechat/packages/wechat-runtime
RUN bun run lint && bun run check && bun run test && bun run build

FROM docker.io/oven/bun:1.3.14 AS runtime
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates squashfs-tools xvfb xauth fonts-noto-cjk fontconfig x11-utils x11-xserver-utils \
    libasound2 libatomic1 libdbus-1-3 libdrm2 libegl1 libexpat1 libfontconfig1 libfreetype6 libgbm1 libgl1 libglib2.0-0 \
    libgssapi-krb5-2 libgtk-3-0 libnotify4 libnss3 libnspr4 libpulse0 libsecret-1-0 libsqlite3-0 libstdc++6 \
    libqt5dbus5 libqt5gui5 libqt5svg5 libqt5widgets5 libx11-6 libx11-xcb1 libxcb1 libxcb-cursor0 libxcb-icccm4 \
    libxcb-image0 libxcb-keysyms1 libxcb-randr0 libxcb-render0 libxcb-render-util0 libxcb-shape0 libxcb-shm0 libxcb-sync1 \
    libxcb-util1 libxcb-xfixes0 libxcb-xinerama0 libxcb-xkb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 \
    libxi6 libxkbcommon0 libxkbcommon-x11-0 libxrandr2 libxrender1 libxtst6 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/matrix-wechat/packages/wechat-runtime
COPY --from=client /opt/wechat-client /opt/wechat-client
ENV WECHAT_INSTALL_DIR=/opt/wechat-client/app
RUN usermod --home /home/wechat --move-home bun \
    && mkdir -p /tmp/runtime-wechat && chown bun:bun /tmp/runtime-wechat && chmod 0700 /tmp/runtime-wechat
COPY --from=build /opt/matrix-wechat /opt/matrix-wechat
COPY --from=native-build /opt/native/download.so /opt/matrix-wechat/packages/wechat-runtime/dist/native/download.so
COPY --from=native-build /opt/native/query.so /opt/matrix-wechat/packages/wechat-runtime/dist/native/query.so
# Verify the prepared client through the application without starting WeChat.
RUN bun -e 'import {Runtime} from "./src/runtime.ts";console.log(await new Runtime().executable())'
ENV HOME=/home/wechat XDG_RUNTIME_DIR=/tmp/runtime-wechat
USER bun
EXPOSE 18742 18743
STOPSIGNAL SIGTERM
ENTRYPOINT ["bun", "/opt/matrix-wechat/packages/wechat-runtime/src/server.ts"]
