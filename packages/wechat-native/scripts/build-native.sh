#!/usr/bin/env bash
set -euo pipefail
native_root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
owl_dir="${1:?Pass the directory containing the pinned libowl.so}"
output_dir="${2:?Pass the build output directory}"
mkdir -p "$output_dir"
output_dir="$(cd -- "$output_dir" && pwd)"
owl_dir="$(cd -- "$owl_dir" && pwd)"
compiler="${CXX:-g++}"
flags=(-std=c++17 -O2 -fexceptions -fvisibility=hidden -Wall -Wextra -Werror -nodefaultlibs)
libraries=(-L"$owl_dir" -Wl,--no-undefined -l:libowl.so -lgcc_s -lc)
"$compiler" "${flags[@]}" -shared -fPIC -DWECHAT_DOWNLOAD_TEST \
  "$native_root/native/download.cc" "$native_root/native/download-eh.S" \
  -Wl,-Bsymbolic "${libraries[@]}" -o "$output_dir/download-test.so"
"$compiler" "${flags[@]}" "$native_root/tests/download.cc" "${libraries[@]}" -ldl \
  -o "$output_dir/download-test"
LD_LIBRARY_PATH="$owl_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
  "$output_dir/download-test" "$output_dir/download-test.so"
"$compiler" "${flags[@]}" -shared -fPIC \
  "$native_root/native/download.cc" "$native_root/native/download-eh.S" \
  -Wl,-Bsymbolic "${libraries[@]}" -o "$output_dir/download.so"
if nm -D --undefined-only "$output_dir/download.so" | grep -E '__cxa_(begin_catch|end_catch|throw|allocate_exception)|__gxx_personality|_Unwind_Resume'; then
  echo 'Native exception forwarders did not bind locally' >&2
  exit 1
fi
# Keep the validated downloader's compiler/linker inputs unchanged.
"$compiler" "${flags[@]}" -shared -fPIC \
  "$native_root/native/query.cc" "$native_root/native/download-eh.S" \
  -Wl,-Bsymbolic,--no-undefined -lgcc_s -lc -lm -o "$output_dir/query.so"
"$compiler" -std=c++17 -O2 -Wall -Wextra -Werror \
  "$native_root/tests/query.cc" -lsqlite3 -ldl -o "$output_dir/query-test"
"$output_dir/query-test" "$output_dir/query.so" "$output_dir/query-doubles.bin" > "$output_dir/query-results.jsonl"
bun "$native_root/../wechat-runtime/scripts/verify-native-query.ts" "$output_dir/query-results.jsonl" "$output_dir/query-doubles.bin"
if nm -D --undefined-only "$output_dir/query.so" | grep -E '__cxa_(begin_catch|end_catch|throw|allocate_exception)|__gxx_personality|_Unwind_Resume'; then
  echo 'Query exception forwarders did not bind locally' >&2
  exit 1
fi
