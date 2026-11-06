// Exercise native ownership and exception unwinding with the bundled libowl ABI.
#include "../native/download-abi.h"
#include <dlfcn.h>
using namespace wechat_download;
struct Target { void **vtable; void *request; };
enum { pending=0, requested=2, smoke_ok=3, rejected=-1, exception=-2, cancelled=-3 };
void *(*wechat_download_submit)(const Shared *,const char *,size_t,uint64_t,int,unsigned);
int (*wechat_download_status)(const void *);
void (*wechat_download_release)(void *);
unsigned (*invalidate)();
unsigned generation=1;
void invoke(Target *t) { reinterpret_cast<void(*)(Target *)>(t->vtable[6])(t); }
void destroy(Target *t) { reinterpret_cast<void(*)(Target *)>(t->vtable[4])(t); }
void destroy_and_free(Target *t) { reinterpret_cast<void(*)(Target *)>(t->vtable[5])(t); }
Target *clone_heap(Target *t) { return reinterpret_cast<Target *(*)(Target *)>(t->vtable[2])(t); }
void clone_into(Target *t,Target *dest) { reinterpret_cast<void(*)(Target *,Target *)>(t->vtable[3])(t,dest); }
#include <assert.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

namespace {
int allocations, lookups, downloads, ui_objects, message_objects;
int throw_stage, post_mode;
unsigned char context_bytes[64]{};
unsigned char other_root[64]{};
uint64_t controls[8][4]{};
Target *queued[8]{};
int queued_count;
uint64_t lookup_id;
void *message_vtable=reinterpret_cast<void *>(0x1234);
void *allocate(size_t n) { ++allocations; void *p=malloc(n); if(!p) throw 1; return p; }
void deallocate(void *p) { if(p) { --allocations; free(p); } }
void release_shared(Shared *p) { assert(p->control); --(static_cast<uint64_t *>(p->control)[1]); }
void owning(Shared *p,void *object,int ctrl) { *p={object,controls[ctrl]}; ++controls[ctrl][1]; }
void *app() { return context_bytes; }
void *queue(Shared *out,void *) { if(throw_stage==1) throw 42; owning(out,context_bytes,1); return out; }
void *context(Shared *out) { owning(out,context_bytes,0); return out; }
void *root(Shared *out,void *) { owning(out,context_bytes,2); return out; }
void *manager(Shared *out,void *) { owning(out,context_bytes,3); return out; }
void *post(Shared *out,void *,Location *,Function *fn,int) {
  if(throw_stage==2) throw 42;
  Target *t=static_cast<Target *>(fn->target); fn->target=nullptr;
  if(post_mode==1) destroy_and_free(t);
  else queued[queued_count++]=t;
  owning(out,context_bytes,4); return out;
}
void *copy_string(String *out,const String *in) {
  if(!(in->bytes[0]&1)) { *out=*in; return out; }
  size_t n; const void *source; memcpy(&n,in->bytes+8,8); memcpy(&source,in->bytes+16,8);
  void *p=allocate(n+1); memcpy(p,source,n); static_cast<char *>(p)[n]=0;
  *out=*in; memcpy(out->bytes+16,&p,8); return out;
}
void *lookup(void *out,void *,const String *chat,uint64_t id,uint64_t) {
  ++lookups; if(throw_stage==3) throw 42;
  unsigned char *m=static_cast<unsigned char *>(out);
  memcpy(m,&message_vtable,8); uint32_t type=3; memcpy(m+0xc,&type,4);
  lookup_id=id; if(throw_stage==5) ++id;
  memcpy(m+0xf8,&id,8); copy_string(reinterpret_cast<String *>(m+0x30),chat);
  m[0x278]=1; ++message_objects;
  if(throw_stage==4) throw 42;
  return out;
}
void *chat(void *p) { return static_cast<unsigned char *>(p)+0x30; }
void destroy_message(void *p) {
  unsigned char *m=static_cast<unsigned char *>(p); assert(m[0x278]); --message_objects;
  auto *s=reinterpret_cast<String *>(m+0x30);
  if(s->bytes[0]&1) { void *b; memcpy(&b,s->bytes+16,8); deallocate(b); }
  m[0x278]=0;
}
void *clone_ui(void *out,void *) { if(throw_stage==6) throw 42; ++ui_objects; return out; }
void destroy_ui(void *) { --ui_objects; }
void *download(Shared *out,void *,void *,int variant,int mode,void *options) {
  assert(variant==3 && mode==0 && *static_cast<uint32_t *>(options)==1);
  if(throw_stage==7) throw 42;
  ++downloads; owning(out,context_bytes,5); return out;
}
API fake_api{allocate,deallocate,release_shared,app,queue,context,root,manager,post,copy_string,
  lookup,chat,destroy_message,clone_ui,destroy_ui,download,message_vtable};
Shared source{context_bytes,controls[0]};
const char *recipient="a_very_long_recipient_for_owned_native_string@chatroom";
void *submit(bool smoke=false) {
  return static_cast<void *>(wechat_download_submit(&source,recipient,strlen(recipient),UINT64_MAX-1,smoke,generation));
}
void drain() {
  for(int i=0;i<queued_count;i++) { invoke(queued[i]); destroy_and_free(queued[i]); }
  queued_count=0;
}
void clean() {
  assert(allocations==0 && ui_objects==0 && message_objects==0);
  for(const auto &c:controls) assert(c[1]==0);
}
} // namespace

int main(int argc,char **argv) {
  void *library=dlopen(argc>1?argv[1]:"./download-test.so",RTLD_NOW|RTLD_LOCAL); if(!library) { puts(dlerror()); return 1; }
  auto setup=reinterpret_cast<void(*)(const API *,void **)>(dlsym(library,"wechat_download_test_api"));
  wechat_download_submit=reinterpret_cast<decltype(wechat_download_submit)>(dlsym(library,"wechat_download_submit"));
  wechat_download_status=reinterpret_cast<decltype(wechat_download_status)>(dlsym(library,"wechat_download_status"));
  wechat_download_release=reinterpret_cast<decltype(wechat_download_release)>(dlsym(library,"wechat_download_release"));
  invalidate=reinterpret_cast<decltype(invalidate)>(dlsym(library,"wechat_download_invalidate"));
  assert(setup&&wechat_download_submit&&wechat_download_status&&wechat_download_release&&invalidate);
  void *owl=dlopen("libowl.so",RTLD_NOW|RTLD_LOCAL); assert(owl);
  void *eh[]={dlsym(owl,"__cxa_begin_catch"),dlsym(owl,"__cxa_end_catch"),dlsym(owl,"__gxx_personality_v0"),dlsym(owl,"_Unwind_Resume")};
  for(void *p:eh) assert(p);
  auto globals=reinterpret_cast<void *(*)()>(dlsym(owl,"__cxa_get_globals")); assert(globals);
  setup(&fake_api,eh);
  void *identity=context_bytes; memcpy(context_bytes+0x28,&identity,8);
  void *r=submit(); assert(r && wechat_download_status(r)==pending);
  // Exercise both callable copy slots; a placed copy fits the 32-byte inline area.
  Target *copy=clone_heap(queued[0]); alignas(16) unsigned char storage[32];
  clone_into(copy,reinterpret_cast<Target *>(storage));
  destroy_and_free(copy); destroy(reinterpret_cast<Target *>(storage));
  drain(); assert(wechat_download_status(r)==requested && downloads==1 && lookup_id==UINT64_MAX-1);
  for(const auto &c:controls) assert(c[1]==0);
  wechat_download_release(r); clean();
  // Native callback remains valid after the JavaScript owner's timeout/release.
  r=submit(); wechat_download_release(r); drain(); clean();
  // A queued callback observes context replacement before touching the message DAO.
  r=submit(); identity=other_root; memcpy(context_bytes+0x28,&identity,8);
  int before=lookups; drain(); assert(wechat_download_status(r)==rejected && before==lookups);
  wechat_download_release(r); identity=context_bytes; memcpy(context_bytes+0x28,&identity,8); clean();
  for(int stage=1;stage<=7;stage++) {
    throw_stage=stage; r=submit(); assert(r); drain();
    assert(wechat_download_status(r)==(stage==5?rejected:exception));
    wechat_download_release(r); clean();
  }
  assert(*reinterpret_cast<unsigned *>(static_cast<unsigned char *>(globals())+8)==0);
  throw_stage=0;
  r=submit(); unsigned old_generation=generation; generation=invalidate();
  assert(!wechat_download_submit(&source,recipient,strlen(recipient),1,0,old_generation));
  drain(); assert(wechat_download_status(r)==rejected); wechat_download_release(r); clean();
  post_mode=1; r=submit(); assert(wechat_download_status(r)==cancelled);
  wechat_download_release(r); clean(); post_mode=0;
  r=submit(true); before=lookups; drain(); assert(wechat_download_status(r)==smoke_ok && before==lookups);
  wechat_download_release(r); clean();
  void *a=submit(),*b=submit(); assert(a&&b&&!submit());
  wechat_download_release(a); wechat_download_release(b); drain(); clean();
  assert(!wechat_download_submit(&source,recipient,strlen(recipient),0,0,generation));
  assert(!wechat_download_submit(&source,"bad\0name",8,1,0,generation)); clean();
  puts("Native callback lifetime, cancellation, identity, bounds and bundled-runtime unwinding passed");
}
