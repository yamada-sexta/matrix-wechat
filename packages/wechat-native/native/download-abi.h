#pragma once
#include <stddef.h>
#include <stdint.h>
namespace wechat_download {
struct Shared { void *object; void *control; };
struct alignas(16) Function { unsigned char buffer[32]; void *target; };
struct Location { const char *function; const char *file; uint32_t line; uint32_t padding; void *pc; };
struct String { unsigned char bytes[24]; };
struct API {
  void *(*allocate)(size_t);
  void (*deallocate)(void *);
  void (*release)(Shared *);
  void *(*app)();
  void *(*queue)(Shared *, void *);
  void *(*context)(Shared *);
  void *(*root)(Shared *, void *);
  void *(*manager)(Shared *, void *);
  void *(*post)(Shared *, void *, Location *, Function *, int);
  void *(*copy_string)(String *, const String *);
  void *(*lookup)(void *, void *, const String *, uint64_t, uint64_t);
  void *(*chat)(void *);
  void (*destroy_message)(void *);
  void *(*clone_ui)(void *, void *);
  void (*destroy_ui)(void *);
  void *(*download)(Shared *, void *, void *, int, int, void *);
  void *message_vtable;
};
}
