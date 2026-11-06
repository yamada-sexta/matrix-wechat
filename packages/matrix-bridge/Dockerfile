FROM docker.io/oven/bun:1.3.14 AS manifests
WORKDIR /opt/matrix-wechat
COPY package.json bun.lock ./
COPY packages/wechat-rpc/package.json ./packages/wechat-rpc/package.json
COPY packages/matrix-bridge/package.json ./packages/matrix-bridge/package.json
COPY packages/wechat-runtime/package.json ./packages/wechat-runtime/package.json
COPY packages/wechat-native/package.json ./packages/wechat-native/package.json

FROM manifests AS build
RUN bun install --frozen-lockfile --filter matrix-wechat-bridge --filter wechat-rpc
COPY .gitignore ./
COPY packages/wechat-rpc ./packages/wechat-rpc
COPY packages/matrix-bridge ./packages/matrix-bridge
COPY example-config.yaml ./example-config.yaml
RUN bun run --cwd packages/wechat-rpc check && bun run --cwd packages/wechat-rpc lint \
    && bun run --cwd packages/matrix-bridge check && bun run --cwd packages/matrix-bridge lint
RUN bun test packages/matrix-bridge/scripts
RUN cd packages/matrix-bridge && bun -e 'const m=await import("matrix-appservice-bridge");console.log(typeof m.Bridge)'

FROM manifests AS dependencies
RUN bun install --production --frozen-lockfile --filter matrix-wechat-bridge --filter wechat-rpc

FROM docker.io/oven/bun:1.3.14 AS runtime
WORKDIR /opt/matrix-wechat
COPY --from=dependencies /opt/matrix-wechat /opt/matrix-wechat
COPY --from=build /opt/matrix-wechat/packages/wechat-rpc/src ./packages/wechat-rpc/src
COPY --from=build /opt/matrix-wechat/packages/matrix-bridge/src ./packages/matrix-bridge/src
COPY example-config.yaml ./example-config.yaml
RUN mkdir -p /data && chown bun:bun /data && chmod 0700 /data
USER bun
VOLUME ["/data"]
EXPOSE 17778
STOPSIGNAL SIGTERM
ENTRYPOINT ["bun", "/opt/matrix-wechat/packages/matrix-bridge/src/main.ts", "-c", "/data/config.yaml"]
