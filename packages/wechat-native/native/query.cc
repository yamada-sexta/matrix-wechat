// Batch SQLite extraction without per-cell JavaScript/native transitions.
// No STL, application callbacks, DB handles, or cipher keys are owned here.
#include "query-abi.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include <locale.h>
#include <fenv.h>

extern "C" {
__attribute__((visibility("hidden"))) void *wechat_eh_begin;
__attribute__((visibility("hidden"))) void *wechat_eh_end;
__attribute__((visibility("hidden"))) void *wechat_eh_personality;
__attribute__((visibility("hidden"))) void *wechat_eh_resume;
}
#define EXPORT extern "C" __attribute__((visibility("default")))
namespace {
wechat_query::API api{};
locale_t numeric_locale;
constexpr size_t cell_limit=8*1024*1024;
// Owned buffers are freed by this DSO, including after exception unwinding.
struct Buffer {
  char *data=nullptr;
  size_t length=0, capacity=0;
  bool failed=false;
  ~Buffer() { free(data); }
  void append(const char *p,size_t n) {
    if(failed) return;
    if(n>=SIZE_MAX-length) { failed=true; return; }
    size_t need=length+n+1;
    if(need>capacity) {
      size_t next=capacity?capacity:4096;
      while(next<need) { if(next>SIZE_MAX/2) { next=need; break; } next*=2; }
      void *allocation=realloc(data,next);
      if(!allocation) { failed=true; return; }
      data=static_cast<char *>(allocation); capacity=next;
    }
    memcpy(data+length,p,n); length+=n; data[length]=0;
  }
  void literal(const char *p) { append(p,strlen(p)); }
  void character(char c) { append(&c,1); }
};
struct Statement {
  void *value=nullptr;
  ~Statement() { if(value) { try { api.finalize(value); } catch(...) {} } }
};
// Match Frida's length-bounded g_utf8_validate: embedded NUL is invalid TEXT.
bool utf8(const unsigned char *p,size_t n) {
  for(size_t i=0;i<n;) {
    unsigned c=p[i++];
    if(!c) return false;
    if(c<0x80) continue;
    unsigned count,code,minimum;
    if(c>=0xc2 && c<=0xdf) { count=1; code=c&31; minimum=0x80; }
    else if(c>=0xe0 && c<=0xef) { count=2; code=c&15; minimum=0x800; }
    else if(c>=0xf0 && c<=0xf4) { count=3; code=c&7; minimum=0x10000; }
    else return false;
    if(count>n-i) return false;
    while(count--) { unsigned d=p[i++]; if((d&0xc0)!=0x80) return false; code=(code<<6)|(d&63); }
    if(code<minimum || code>0x10ffff || (code>=0xd800 && code<=0xdfff)) return false;
  }
  return true;
}
void quoted(Buffer &out,const unsigned char *p,size_t n) {
  static const char hex[]="0123456789abcdef";
  out.character('"');
  size_t start=0;
  for(size_t i=0;i<n;i++) {
    unsigned c=p[i];
    if(c>=32 && c!='"' && c!='\\') continue;
    out.append(reinterpret_cast<const char *>(p+start),i-start);
    if(c=='"' || c=='\\') { out.character('\\'); out.character(static_cast<char>(c)); }
    else { char escaped[]={'\\','u','0','0',hex[c>>4],hex[c&15]}; out.append(escaped,6); }
    start=i+1;
  }
  out.append(reinterpret_cast<const char *>(p+start),n-start); out.character('"');
}
void binary(Buffer &out,const unsigned char *p,size_t n) {
  out.literal("{\"bytes\":[");
  for(size_t i=0;i<n && !out.failed;i++) {
    if(i) out.character(',');
    char digits[4]; int size=snprintf(digits,sizeof(digits),"%u",p[i]); out.append(digits,static_cast<size_t>(size));
  }
  out.literal("]}");
}
void error(Buffer &out,const char *message) { out.length=0; out.literal(message?message:"SQLite failure"); }
bool whitespace(const char *tail) {
  const auto *p=reinterpret_cast<const unsigned char *>(tail);
  size_t n=strlen(tail);
  if(!utf8(p,n)) return false;
  for(size_t i=0;i<n;) {
    unsigned c=p[i++];
    if(c>=128) {
      unsigned count=c<0xe0?1:c<0xf0?2:3;
      c&=count==1?31:count==2?15:7;
      while(count--) c=(c<<6)|(p[i++]&63);
    }
    if(!((c>=9 && c<=13) || c==32 || c==0xa0 || c==0x1680 ||
         (c>=0x2000 && c<=0x200a) || c==0x2028 || c==0x2029 ||
         c==0x202f || c==0x205f || c==0x3000 || c==0xfeff)) return false;
  }
  return true;
}
int run(void *db,const char *sql,unsigned max_rows,bool allow_write,Buffer &out) {
  Statement statement;
  const char *tail=nullptr;
  int rc=api.prepare(db,sql,-1,&statement.value,&tail);
  if(rc) { error(out,api.error(db)); return -1; }
  if(!statement.value) { error(out,"Empty SQL statement"); return -1; }
  uintptr_t begin=reinterpret_cast<uintptr_t>(sql), end=begin+strlen(sql), rest=reinterpret_cast<uintptr_t>(tail);
  if(!tail || rest<begin || rest>end) { error(out,"Invalid SQL tail"); return -1; }
  // Match ECMAScript trim, including its Unicode whitespace set.
  if(!whitespace(tail)) {
    error(out,"Only one SQL statement allowed"); return -1;
  }
  if(!allow_write && !api.readonly(statement.value)) { error(out,"Query is not read-only"); return -1; }
  int columns=api.count(statement.value);
  out.literal("{\"columns\":[");
  for(int i=0;i<columns;i++) {
    if(i) out.character(',');
    const char *name=api.name(statement.value,i); if(!name) name="";
    size_t n=strlen(name);
    if(!utf8(reinterpret_cast<const unsigned char *>(name),n)) { error(out,"Invalid column name"); return -1; }
    quoted(out,reinterpret_cast<const unsigned char *>(name),n);
  }
  out.literal("],\"rows\":[");
  unsigned rows=0; bool truncated=false;
  while(!out.failed) {
    rc=api.step(statement.value);
    if(rc==101) break;
    if(rc!=100) { error(out,api.error(db)); return -1; }
    if(rows>=max_rows) { truncated=true; break; }
    if(rows++) out.character(',');
    out.character('[');
    for(int i=0;i<columns && !out.failed;i++) {
      if(i) out.character(',');
      int type=api.type(statement.value,i);
      if(type==1) {
        char value[24]; int n=snprintf(value,sizeof(value),"\"%lld\"",static_cast<long long>(api.integer(statement.value,i)));
        out.append(value,static_cast<size_t>(n));
      } else if(type==2) {
        double value=api.real(statement.value,i);
        if(!isfinite(value)) out.literal("null");
        else {
          char text[32];
          locale_t before=uselocale(numeric_locale);
          int rounding=fegetround();
          if(rounding<0 || fesetround(FE_TONEAREST)) { uselocale(before); error(out,"Numeric rounding mode unavailable"); return -1; }
          int n=snprintf(text,sizeof(text),"%.17g",value);
          fesetround(rounding);
          uselocale(before);
          if(n<0 || static_cast<size_t>(n)>=sizeof(text)) { error(out,"Numeric formatting failed"); return -1; }
          out.append(text,static_cast<size_t>(n));
        }
      } else if(type==3 || type==4) {
        const void *p=type==3?api.text(statement.value,i):api.blob(statement.value,i);
        int n=api.bytes(statement.value,i);
        if(n<0 || static_cast<size_t>(n)>cell_limit) { error(out,type==3?"Text exceeds read limit":"Blob exceeds read limit"); return -1; }
        if(n && !p) { error(out,"Cannot read null cell"); return -1; }
        const auto *bytes=static_cast<const unsigned char *>(p?p:static_cast<const void *>(""));
        if(type==3 && utf8(bytes,static_cast<size_t>(n))) quoted(out,bytes,static_cast<size_t>(n));
        else binary(out,bytes,static_cast<size_t>(n));
      } else out.literal("null");
    }
    out.character(']');
  }
  out.literal(truncated?"],\"truncated\":true}":"],\"truncated\":false}");
  return out.failed?-1:0;
}
}
EXPORT int wechat_query_init(const wechat_query::API *functions,void **eh) {
  if(!functions || !eh) return -1;
  if(!numeric_locale) numeric_locale=newlocale(LC_NUMERIC_MASK,"C",nullptr);
  if(!numeric_locale) return -1;
  api=*functions;
  wechat_eh_begin=eh[0]; wechat_eh_end=eh[1]; wechat_eh_personality=eh[2]; wechat_eh_resume=eh[3];
  return 0;
}
// 0=complete, -1=error. Never return a partial result.
EXPORT int wechat_query_run(void *db,const char *sql,unsigned rows,int allow_write,char **data,uint64_t *length) {
  *data=nullptr; *length=0;
  Buffer out;
  int result;
  try { result=run(db,sql,rows,allow_write!=0,out); }
  catch(...) { out.length=0; out.failed=false; error(out,"Native SQLite exception"); result=-1; }
  if(out.failed) return -1;
  *data=out.data; *length=out.length; out.data=nullptr;
  return result;
}
EXPORT void wechat_query_free(void *data) { free(data); }
