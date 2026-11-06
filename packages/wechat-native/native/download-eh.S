// Bind the adapter to the main executable's exception runtime. libowl has a
// different exception TLS key, even though its C++ header layout is identical.
// Tail jumps preserve every ABI argument and add no extra unwind frame.
.text
.macro FORWARD symbol, pointer
  .globl \symbol
  .hidden \symbol
  .type \symbol, @function
\symbol:
  jmp *\pointer(%rip)
  .size \symbol, .-\symbol
.endm
FORWARD __cxa_begin_catch, wechat_eh_begin
FORWARD __cxa_end_catch, wechat_eh_end
FORWARD __gxx_personality_v0, wechat_eh_personality
FORWARD _Unwind_Resume, wechat_eh_resume
.section .note.GNU-stack,"",@progbits
