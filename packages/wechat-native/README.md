# WeChat native integration

[English](README.md) | [简体中文](README.zh-CN.md)

This workspace owns code injected into the pinned WeChat process. Its TypeScript project uses Frida types, independently of the Bun runtime application. Repository-root checks include both projects. The runtime bundles `src/instrument.ts` into its image and loads the profiles through this package's exports.

`native/download.cc` implements original-image requests on WeChat's native coroutine queue. Native lookup, payload cloning, download, exception handling, and capture cleanup stay inside the compiled callback. The Frida layer calls only its non-yielding producer and polling interface. Account/session generations invalidate stale work; requests are bounded and retain their own state across JavaScript timeouts. The library stays loaded until process exit.

All native addresses are original ELF RVAs, checked against instruction bytes and function boundaries. The adapter forwards exception handling to the main executable's hidden runtime: bundled `libowl.so` has a separate exception TLS key and cannot supply the catch runtime for main-executable exceptions.

`native/query.cc` batches SQLite prepare, step, extraction, and finalization in one synchronous call on the existing dedicated read-only FULLMUTEX reader. Cipher setup and WCDB decompression use the same reader. Integer strings, binary/invalid-text cells, exact doubles, Unicode SQL-tail validation, cell limits, and row truncation are preserved. The query adapter is required; there is no JavaScript query fallback. Its separate library leaves the downloader attestation unchanged. Numeric formatting temporarily uses the C numeric locale and nearest rounding mode, restoring both before returning.

Build locally against the pinned client's `libowl.so`:

```sh
bash packages/wechat-native/scripts/build-native.sh /path/to/opt/wechat packages/wechat-native/dist
```

The build also requires Bun, SQLite development headers/libraries, and the `de_DE.UTF-8` locale for numeric regression checks. The script tests a dynamically loaded adapter, including cancellation, copies, account/session changes, exception cleanup and timeout ownership, then builds the production library and checks exception-symbol binding. The runtime Dockerfile runs the same script during CI; the production image contains no compiler. Live automatic requests remain gated by the runtime's message-bound original-download validation.

The same build tests the query library against real SQLite, compares JSON doubles to independently read binary values under non-C locale and rounding modes, checks limits and finalization, exercises exception unwinding through the DSO, and audits locally bound exception symbols.
