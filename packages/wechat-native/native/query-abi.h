#pragma once
#include <stddef.h>
#include <stdint.h>
// Only synchronous calls on the existing dedicated FULLMUTEX reader.
namespace wechat_query {
struct API {
  int (*prepare)(void *, const char *, int, void **, const char **);
  int (*step)(void *);
  int (*finalize)(void *);
  int (*readonly)(void *);
  int (*count)(void *);
  const char *(*name)(void *, int);
  int (*type)(void *, int);
  int64_t (*integer)(void *, int);
  double (*real)(void *, int);
  const unsigned char *(*text)(void *, int);
  const void *(*blob)(void *, int);
  int (*bytes)(void *, int);
  const char *(*error)(void *);
};
}
