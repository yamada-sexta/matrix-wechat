// Adapter for the pinned Linux client, not a general WeChat ABI.
// The entire yielding operation stays on the client's native coroutine stack.
// No STL objects cross this boundary. Keep this library loaded until process exit.
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <typeinfo>
#include <new>
#include "download-abi.h"
extern "C" {
__attribute__((visibility("hidden"))) void *wechat_eh_begin;
__attribute__((visibility("hidden"))) void *wechat_eh_end;
__attribute__((visibility("hidden"))) void *wechat_eh_personality;
__attribute__((visibility("hidden"))) void *wechat_eh_resume;
}

#define EXPORT extern "C" __attribute__((visibility("default")))
namespace {
using namespace wechat_download;
API api{};
uintptr_t image_base;
unsigned active;
unsigned generation=1;
enum State { pending=0, running=1, requested=2, smoke_ok=3, rejected=-1, exception=-2, cancelled=-3 };

struct Holder {
  Shared value{};
  ~Holder() { if(value.control) { api.release(&value); value={}; } }
};
struct NativeString {
  String value{};
  ~NativeString() { if(value.bytes[0]&1) { void *p; memcpy(&p,value.bytes+16,8); api.deallocate(p); } }
};
struct Request {
  unsigned references;
  unsigned targets;
  int state;
  bool smoke;
  unsigned generation;
  Holder context;
  Holder root;
  NativeString chat;
  uint64_t id;
};
struct Target { void **vtable; Request *request; };
static_assert(sizeof(Target)<=32);
static_assert(offsetof(Function,target)==32);
static_assert(sizeof(Location)==32);

void retain(Request *r) { __atomic_add_fetch(&r->references,1,__ATOMIC_RELAXED); }
void release(Request *r) {
  if(__atomic_sub_fetch(&r->references,1,__ATOMIC_ACQ_REL)==0) {
    r->~Request(); api.deallocate(r);
  }
}
void retain_shared(Shared *out,const Shared *in) {
  *out=*in;
  if(out->control) __atomic_add_fetch(reinterpret_cast<uint64_t *>(out->control)+1,1,__ATOMIC_RELAXED);
}
bool same_string(const String *a,const String *b) {
  auto size=[](const String *s)->size_t { size_t n; if(s->bytes[0]&1) memcpy(&n,s->bytes+8,8); else n=s->bytes[0]>>1; return n; };
  auto bytes=[](const String *s)->const void * { const void *p; if(s->bytes[0]&1) memcpy(&p,s->bytes+16,8); else p=s->bytes+1; return p; };
  size_t n=size(a); return n<=256 && n==size(b) && memcmp(bytes(a),bytes(b),n)==0;
}
bool current_root(Request *r) {
  if(r->generation!=__atomic_load_n(&generation,__ATOMIC_ACQUIRE)) return false;
  Holder now; api.context(&now.value);
  if(!now.value.object || !r->root.value.object) return false;
  void *expected=r->root.value.object,*actual;
  memcpy(&actual,static_cast<unsigned char *>(now.value.object)+0x28,8);
  return expected && expected==actual;
}
struct Message {
  alignas(16) unsigned char value[0x280]{};
  ~Message() { if(value[0x278]) api.destroy_message(value); }
};
struct UI {
  alignas(16) unsigned char value[0x350]{};
  bool initialized=false;
  ~UI() { if(initialized) api.destroy_ui(value); }
};
void clear_captures(Request *r) noexcept {
  r->chat.~NativeString(); new (&r->chat) NativeString{};
  r->root.~Holder(); new (&r->root) Holder{};
  r->context.~Holder(); new (&r->context) Holder{};
}
void invoke(Target *target) noexcept {
  Request *r=target->request;
  int expected=pending;
  if(!__atomic_compare_exchange_n(&r->state,&expected,running,false,__ATOMIC_ACQ_REL,__ATOMIC_ACQUIRE)) return;
  int outcome=rejected;
  try {
    if(current_root(r)) {
      if(r->smoke) outcome=smoke_ok;
      else {
        Holder manager;
        api.manager(&manager.value,r->root.value.object);
        if(manager.value.object && current_root(r)) {
          Message message;
          api.lookup(message.value,manager.value.object,&r->chat.value,r->id,0);
          uint32_t type; uint64_t id; void *vtable;
          memcpy(&type,message.value+0xc,4); memcpy(&id,message.value+0xf8,8); memcpy(&vtable,message.value,8);
          if(message.value[0x278] && vtable==api.message_vtable && type==3 && id==r->id &&
             same_string(static_cast<String *>(api.chat(message.value)),&r->chat.value) && current_root(r)) {
            UI ui; api.clone_ui(ui.value,message.value); ui.initialized=true;
            alignas(16) unsigned char options[0x38]{};
            *reinterpret_cast<uint32_t *>(options)=1;
            Holder task;
            api.download(&task.value,manager.value.object,ui.value,3,0,options);
            // A task only acknowledges the request. The bridge must still verify cached MD5.
            if(task.value.object && current_root(r)) outcome=requested;
          }
        }
      }
    }
  } catch(...) { outcome=exception; }
  clear_captures(r);
  __atomic_store_n(&r->state,outcome,__ATOMIC_RELEASE);
  __atomic_sub_fetch(&active,1,__ATOMIC_ACQ_REL);
}
void destroy(Target *t) noexcept {
  Request *r=t->request; if(!r) return; t->request=nullptr;
  if(__atomic_sub_fetch(&r->targets,1,__ATOMIC_ACQ_REL)==0) {
    int expected=pending;
    if(__atomic_compare_exchange_n(&r->state,&expected,running,false,__ATOMIC_ACQ_REL,__ATOMIC_ACQUIRE)) {
      clear_captures(r);
      __atomic_store_n(&r->state,cancelled,__ATOMIC_RELEASE);
      __atomic_sub_fetch(&active,1,__ATOMIC_ACQ_REL);
    }
  }
  release(r);
}
void destroy_and_free(Target *t) noexcept { destroy(t); api.deallocate(t); }
void clone_into(Target *t,Target *out) {
  new (out) Target(*t); retain(out->request); __atomic_add_fetch(&out->request->targets,1,__ATOMIC_RELAXED);
}
Target *clone_heap(Target *t) {
  auto *out=static_cast<Target *>(api.allocate(sizeof(Target))); clone_into(t,out); return out;
}
void *target_type(Target *t,const std::type_info *type) { return type==&typeid(Target)?t:nullptr; }
const std::type_info *type_info(Target *) { return &typeid(Target); }
// Address point has the Itanium offset-to-top/RTTI prefix and the pinned libc++ slots.
void *vtable[]={nullptr,const_cast<std::type_info *>(&typeid(Target)),
  reinterpret_cast<void *>(destroy),reinterpret_cast<void *>(destroy_and_free),
  reinterpret_cast<void *>(clone_heap),reinterpret_cast<void *>(clone_into),
  reinterpret_cast<void *>(destroy),reinterpret_cast<void *>(destroy_and_free),
  reinterpret_cast<void *>(invoke),reinterpret_cast<void *>(target_type),reinterpret_cast<void *>(type_info)};

#include "download-guards.inc"
} // namespace

EXPORT int wechat_download_init(uintptr_t base) noexcept {
  if(image_base) return image_base==base?0:-1;
  if(!base || !validate(base)) return -1;
  wechat_eh_begin=reinterpret_cast<void *>(base+0x44f3ce0);
  wechat_eh_end=reinterpret_cast<void *>(base+0x44f3ea0);
  wechat_eh_personality=reinterpret_cast<void *>(base+0x44f4690);
  wechat_eh_resume=reinterpret_cast<void *>(base+0x44eee20);
  api={reinterpret_cast<decltype(api.allocate)>(base+0xa674ee0),
       reinterpret_cast<decltype(api.deallocate)>(base+0x450c140),
       reinterpret_cast<decltype(api.release)>(base+0x470a2e0),
       reinterpret_cast<decltype(api.app)>(base+0x6041320),
       reinterpret_cast<decltype(api.queue)>(base+0x60422b0),
       reinterpret_cast<decltype(api.context)>(base+0x60421e0),
       reinterpret_cast<decltype(api.root)>(base+0x619ce90),
       reinterpret_cast<decltype(api.manager)>(base+0x61ad930),
       reinterpret_cast<decltype(api.post)>(base+0x6247520),
       reinterpret_cast<decltype(api.copy_string)>(base+0x4539520),
       reinterpret_cast<decltype(api.lookup)>(base+0x64f1d50),
       reinterpret_cast<decltype(api.chat)>(base+0x605bb40),
       reinterpret_cast<decltype(api.destroy_message)>(base+0x5cdc000),
       reinterpret_cast<decltype(api.clone_ui)>(base+0x605e8a0),
       reinterpret_cast<decltype(api.destroy_ui)>(base+0x472f190),
       reinterpret_cast<decltype(api.download)>(base+0x6517cd0),reinterpret_cast<void *>(base+0xa89e430)};
  image_base=base; return 0;
}

// Called only at the existing account-ready instruction probe. Copies all inputs
// before returning; the queue's callback owns its state independently of Frida.
EXPORT unsigned wechat_download_invalidate() noexcept {
  unsigned value=__atomic_load_n(&generation,__ATOMIC_ACQUIRE);
  do { if(value==UINT32_MAX) return 0; }
  while(!__atomic_compare_exchange_n(&generation,&value,value+1,false,__ATOMIC_ACQ_REL,__ATOMIC_ACQUIRE));
  return value+1;
}
EXPORT void *wechat_download_submit(const Shared *context,const char *chat,size_t length,uint64_t id,int smoke,unsigned expected_generation) noexcept {
  if(!image_base || !context || !context->object || !context->control || !chat || !length || length>256 ||
     memchr(chat,0,length) || (!smoke && !id) || (smoke!=0 && smoke!=1) ||
     expected_generation!=__atomic_load_n(&generation,__ATOMIC_ACQUIRE) || expected_generation==UINT32_MAX) return nullptr;
  unsigned previous=__atomic_fetch_add(&active,1,__ATOMIC_ACQ_REL);
  if(previous>=2) { __atomic_sub_fetch(&active,1,__ATOMIC_ACQ_REL); return nullptr; }
  Request *r=nullptr; Function function{};
  try {
    r=static_cast<Request *>(api.allocate(sizeof(Request))); new (r) Request{};
    r->references=1; r->id=id; r->smoke=smoke!=0; r->generation=expected_generation;
    retain_shared(&r->context.value,context);
    api.root(&r->root.value,context->object);
    if(!r->root.value.object || !r->root.value.control) {
      clear_captures(r); __atomic_store_n(&r->state,rejected,__ATOMIC_RELEASE);
      __atomic_sub_fetch(&active,1,__ATOMIC_ACQ_REL); return r;
    }
    String input{};
    if(length<23) { input.bytes[0]=length*2; memcpy(input.bytes+1,chat,length); }
    else { const size_t capacity=(length+16)&~size_t(15); const size_t tag=capacity|1;
      memcpy(input.bytes,&tag,8); memcpy(input.bytes+8,&length,8); memcpy(input.bytes+16,&chat,8); }
    api.copy_string(&r->chat.value,&input);
    auto *target=static_cast<Target *>(api.allocate(sizeof(Target)));
    new (target) Target{vtable+2,r}; retain(r); r->targets=1; function.target=target;
    Holder queue,job;
    void *app=api.app();
    if(app) api.queue(&queue.value,app);
    if(queue.value.object) {
    Location location{"download_original","matrix-wechat/native/download.cc",1,0,reinterpret_cast<void *>(image_base+0x6247520)};
    api.post(&job.value,queue.value.object,&location,&function,1);
    }
  } catch(...) {
    if(r) {
      int expected=pending;
      if(__atomic_compare_exchange_n(&r->state,&expected,running,false,__ATOMIC_ACQ_REL,__ATOMIC_ACQUIRE)) {
        clear_captures(r);
        __atomic_store_n(&r->state,exception,__ATOMIC_RELEASE);
        __atomic_sub_fetch(&active,1,__ATOMIC_ACQ_REL);
      }
    } else __atomic_sub_fetch(&active,1,__ATOMIC_ACQ_REL);
  }
  if(function.target) destroy_and_free(static_cast<Target *>(function.target));
  return r;
}
EXPORT int wechat_download_status(const Request *r) noexcept { return r?__atomic_load_n(&r->state,__ATOMIC_ACQUIRE):rejected; }
EXPORT void wechat_download_release(Request *r) noexcept { if(r) release(r); }

#ifdef WECHAT_DOWNLOAD_TEST
// Test-only API substitution; absent from production artifacts.
EXPORT void wechat_download_test_api(const API *value,void **eh) {
  wechat_eh_begin=eh[0]; wechat_eh_end=eh[1]; wechat_eh_personality=eh[2]; wechat_eh_resume=eh[3];
  api=*value; image_base=1; active=0;
}
#endif
