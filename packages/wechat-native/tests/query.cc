// Real SQLite checks through a dynamically loaded DSO, including unwinding.
#include "../native/query-abi.h"
#include <sqlite3.h>
#include <dlfcn.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <locale.h>
#include <fenv.h>
#include <math.h>
#include <initializer_list>
namespace { bool throwing=false;
int step(void *s) { if(throwing) throw 42; return sqlite3_step(static_cast<sqlite3_stmt *>(s)); }
void fixed_real(sqlite3_context *context,int,sqlite3_value **) {
  uint64_t bits=0x5804f92283868a29; double value; memcpy(&value,&bits,8); sqlite3_result_double(context,value);
}
}
int main(int argc,char **argv) {
  assert(argc==3);
  FILE *expected_bits=fopen(argv[2],"wb"); assert(expected_bits);
  void *lib=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL); if(!lib) { puts(dlerror()); return 1; }
  auto init=reinterpret_cast<int(*)(const wechat_query::API *,void **)>(dlsym(lib,"wechat_query_init"));
  auto run=reinterpret_cast<int(*)(void *,const char *,unsigned,int,char **,uint64_t *)>(dlsym(lib,"wechat_query_run"));
  auto release=reinterpret_cast<void(*)(void *)>(dlsym(lib,"wechat_query_free")); assert(init&&run&&release);
  wechat_query::API api{
    reinterpret_cast<decltype(api.prepare)>(sqlite3_prepare_v2),step,
    reinterpret_cast<decltype(api.finalize)>(sqlite3_finalize),
    reinterpret_cast<decltype(api.readonly)>(sqlite3_stmt_readonly),
    reinterpret_cast<decltype(api.count)>(sqlite3_column_count),
    reinterpret_cast<decltype(api.name)>(sqlite3_column_name),
    reinterpret_cast<decltype(api.type)>(sqlite3_column_type),
    reinterpret_cast<decltype(api.integer)>(sqlite3_column_int64),
    reinterpret_cast<decltype(api.real)>(sqlite3_column_double),
    reinterpret_cast<decltype(api.text)>(sqlite3_column_text),
    reinterpret_cast<decltype(api.blob)>(sqlite3_column_blob),
    reinterpret_cast<decltype(api.bytes)>(sqlite3_column_bytes),
    reinterpret_cast<decltype(api.error)>(sqlite3_errmsg)};
  void *eh[]={dlsym(RTLD_DEFAULT,"__cxa_begin_catch"),dlsym(RTLD_DEFAULT,"__cxa_end_catch"),dlsym(RTLD_DEFAULT,"__gxx_personality_v0"),dlsym(RTLD_DEFAULT,"_Unwind_Resume")};
  for(void *p:eh) assert(p);
  assert(init(&api,eh)==0);
  sqlite3 *db=nullptr; assert(sqlite3_open_v2(":memory:",&db,SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE|SQLITE_OPEN_FULLMUTEX,nullptr)==0);
  assert(sqlite3_exec(db,"CREATE TABLE t(x); INSERT INTO t VALUES(1),(2),(3)",nullptr,nullptr,nullptr)==0);
  assert(sqlite3_create_function(db,"fixed_real",0,SQLITE_UTF8,nullptr,fixed_real,nullptr,nullptr)==0);
  auto query=[&](const char *sql,unsigned limit,int expected,const char *json=nullptr,int write=0) {
    char *data=nullptr; uint64_t n=0; int rc=run(db,sql,limit,write,&data,&n); assert(rc==expected);
    if(json && (!data || strcmp(json,data))) { fprintf(stderr,"Mismatch for %s\nExpected %s\nActual %s\n",sql,json,data?data:"(null)"); abort(); }
    if(rc==0) {
      assert(data&&strlen(data)==n); puts(data);
      sqlite3_stmt *reference=nullptr; assert(sqlite3_prepare_v2(db,sql,-1,&reference,nullptr)==0);
      unsigned count=0;
      while(sqlite3_step(reference)==SQLITE_ROW && count++<limit)
        for(int i=0;i<sqlite3_column_count(reference);i++) if(sqlite3_column_type(reference,i)==SQLITE_FLOAT) {
          double value=sqlite3_column_double(reference,i); if(isfinite(value)) assert(fwrite(&value,8,1,expected_bits)==1);
        }
      sqlite3_finalize(reference);
    }
    release(data); assert(sqlite3_next_stmt(db,nullptr)==nullptr);
  };
  query("SELECT -9223372036854775808 AS lo,9223372036854775807 AS hi,9007199254740993 AS big,NULL AS nil",10,0,
    "{\"columns\":[\"lo\",\"hi\",\"big\",\"nil\"],\"rows\":[[\"-9223372036854775808\",\"9223372036854775807\",\"9007199254740993\",null]],\"truncated\":false}");
  query("SELECT '中文😀' AS u,'' AS empty,x'' AS blob,CAST(x'80ff' AS TEXT) AS bad,CAST(x'610062' AS TEXT) AS nul,'a'||char(10,9,34,92) AS escaped",10,0,
    "{\"columns\":[\"u\",\"empty\",\"blob\",\"bad\",\"nul\",\"escaped\"],\"rows\":[[\"中文😀\",\"\",{\"bytes\":[]},{\"bytes\":[128,255]},{\"bytes\":[97,0,98]},\"a\\u000a\\u0009\\\"\\\\\"]],\"truncated\":false}");
  assert(setlocale(LC_NUMERIC,"de_DE.UTF-8"));
  assert(strcmp(localeconv()->decimal_point,",")==0);
  query("SELECT 0.1 AS fraction,1e300 AS big,1e-300 AS small,1e999 AS inf,-1e999 AS neg_inf",10,0);
  for(int mode:{FE_UPWARD,FE_DOWNWARD}) {
    assert(fesetround(mode)==0); query("SELECT fixed_real()",1,0); assert(fegetround()==mode);
    assert(strcmp(localeconv()->decimal_point,",")==0);
  }
  assert(fesetround(FE_TONEAREST)==0);
  query("SELECT x FROM t ORDER BY x",2,0,"{\"columns\":[\"x\"],\"rows\":[[\"1\"],[\"2\"]],\"truncated\":true}");
  query("SELECT x FROM t ORDER BY x",3,0,"{\"columns\":[\"x\"],\"rows\":[[\"1\"],[\"2\"],[\"3\"]],\"truncated\":false}");
  query("SELECT x FROM t WHERE 0",2,0,"{\"columns\":[\"x\"],\"rows\":[],\"truncated\":false}");
  query("SELECT 1; \t\r\n",1,0);
  query("SELECT 1;\xc2\xa0\xe3\x80\x80\xef\xbb\xbf",1,0);
  query("SELECT 1;\xe2\x80\x8b",1,-1); // zero width space is not ES whitespace
  query("SELECT 1; SELECT 2",1,-1); query("SELECT 1; -- comment",1,-1);
  query("UPDATE t SET x=4",1,-1); query("",1,-1); query("SELECT unknown FROM t",1,-1);
  query("SELECT abs(-9223372036854775808)",1,-1);
  query("SELECT zeroblob(8388609)",1,-1); query("SELECT CAST(zeroblob(8388609) AS TEXT)",1,-1);
  throwing=true; query("SELECT 1",1,-1); throwing=false;
  query("SELECT 1",1,0);
  query("PRAGMA cache_size=100",1,0,nullptr,1);
  assert(sqlite3_close(db)==0);
  assert(fclose(expected_bits)==0);
}
