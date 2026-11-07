import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { loginRequestSchema, textMessageSchema } from "./schemas";
import {
  APIError,
  type ChangeBatch,
  type ChangeCursor,
  type Contact,
  type Conversation,
  type Group,
  type Message,
  type Status,
} from "./types";

export interface Backend {
  changes(input: ChangeCursor): Promise<ChangeBatch>;
  status(): { status: Status; qrAt: number; qrAvailable: boolean };
  contacts(): Promise<Contact[]>;
  groups(): Promise<Group[]>;
  conversations(): Promise<Conversation[]>;
  history(input: {
    chat: string;
    cursor?: string;
  }): Promise<{ messages: Message[]; cursor: string; done: boolean }>;
  recent(chat: string): Promise<Message[]>;
  revocations(): Promise<{ chat: string; id: string }[]>;
  login(input: z.infer<typeof loginRequestSchema>): Promise<unknown>;
  logout(): Promise<{ success: true }>;
  send(input: z.infer<typeof textMessageSchema>): Promise<unknown>;
  upload(chat: string, file: File, kind: "image" | "file"): Promise<unknown>;
}
const t = initTRPC.context<Backend>().create({
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      // Only explicit public runtime errors cross the API boundary.
      message:
        error.cause instanceof APIError
          ? error.cause.message
          : error.code === "INTERNAL_SERVER_ERROR"
            ? "Runtime operation failed"
            : shape.message,
      data: {
        ...shape.data,
        stack: undefined,
        runtimeCode: error.cause instanceof APIError ? error.cause.code : undefined,
      },
    };
  },
});
const chat = z.string().min(1);
export const router = t.router({
  changes: t.procedure
    .input(
      z.object({
        epoch: z.string().max(64).optional(),
        cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        wait_ms: z.number().int().min(0).max(25000).default(25000),
      }),
    )
    .query(({ ctx, input }) => ctx.changes(input)),
  status: t.procedure.query(({ ctx }) => ctx.status()),
  contacts: t.procedure.query(({ ctx }) => ctx.contacts()),
  groups: t.procedure.query(({ ctx }) => ctx.groups()),
  conversations: t.procedure.query(({ ctx }) => ctx.conversations()),
  history: t.procedure
    .input(z.object({ chat, cursor: z.string().optional() }))
    .query(({ ctx, input }) => ctx.history(input)),
  recent: t.procedure.input(z.object({ chat })).query(({ ctx, input }) => ctx.recent(input.chat)),
  revocations: t.procedure.query(({ ctx }) => ctx.revocations()),
  login: t.procedure.input(loginRequestSchema).mutation(({ ctx, input }) => ctx.login(input)),
  logout: t.procedure.mutation(({ ctx }) => ctx.logout()),
  send: t.procedure.input(textMessageSchema).mutation(({ ctx, input }) => ctx.send(input)),
  upload: t.procedure
    .input(
      z.instanceof(FormData).transform((form, context) => {
        const chat = form.get("chat"),
          file = form.get("file"),
          kind = form.get("kind");
        if (
          typeof chat !== "string" ||
          !chat ||
          !(file instanceof File) ||
          (kind !== "image" && kind !== "file")
        ) {
          context.addIssue({
            code: "custom",
            message: "A conversation, file, and upload kind are required",
          });
          return z.NEVER;
        }
        return { chat, file, kind: kind as "image" | "file" };
      }),
    )
    .mutation(({ ctx, input }) => ctx.upload(input.chat, input.file, input.kind)),
});
export type Router = typeof router;
