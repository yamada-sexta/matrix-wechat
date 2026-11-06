import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-f]+$/i);
const instructionBytes = z.string().regex(/^(?:[0-9a-f]{2})+$/i);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const nativeFunction = z.object({ rva: address, validation_bytes: instructionBytes });

export const storageProfileSchema = z
  .object({
    schema_version: z.literal(1),
    artifact: z.object({ sha256: hash, appimage_sha256: hash }).passthrough(),
    functions: z.record(z.string(), address),
    validation_bytes: z.record(z.string(), instructionBytes),
    compression: z
      .object({
        scalar_name: z.string().min(1),
        argument_count: z.int().positive(),
        sqlite_encoding_flags: z.int().nonnegative(),
        scalar_callback_rva: address,
      })
      .passthrough(),
  })
  .passthrough();

export const outboundProfileSchema = z
  .object({
    format_version: z.literal(1),
    elf_sha256: hash,
    functions: z.record(z.string(), nativeFunction),
    uploads: z.object({
      file_context: nativeFunction,
      file_path_call: nativeFunction,
      file_path_ready: nativeFunction,
      image_entry: nativeFunction,
      assign_string: nativeFunction,
    }),
  })
  .passthrough();

export const sessionProfileSchema = z.object({
  format_version: z.literal(1),
  elf_sha256: hash,
  controller: z.object({ rva: address, vtable: address }),
  login: z.object({
    vtable: address,
    window_vtable: address,
    model_offset: z.int().positive(),
    qr_data_offset: z.literal(576),
  }),
  functions: z.object({
    model_constructor: nativeFunction,
    model_destructor: nativeFunction,
    model_state_changed: nativeFunction,
    allocate: nativeFunction,
    free: nativeFunction,
    queue: nativeFunction,
    qr_slot: nativeFunction,
    qr_received: nativeFunction,
    prompt_slot: nativeFunction,
    logout: nativeFunction,
  }),
});

export type StorageProfile = z.infer<typeof storageProfileSchema>;
export type OutboundProfile = z.infer<typeof outboundProfileSchema>;
export type SessionProfile = z.infer<typeof sessionProfileSchema>;
