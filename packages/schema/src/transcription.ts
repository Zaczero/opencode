export * as Transcription from "./transcription.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"

// Standard Schema keeps the definition portable, so Promise clients (the TUI) can call it directly.
export const Definition = Rpc.define({
  id: "opencode.transcription",
  methods: {
    transcribe: {
      /** Base64 16-bit PCM WAV. */
      input: Schema.toStandardSchemaV1(Schema.Struct({ audio: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.Struct({ text: Schema.String })),
      errors: {
        unavailable: Schema.toStandardSchemaV1(Schema.Struct({})),
        failed: Schema.toStandardSchemaV1(Schema.Struct({})),
      },
    },
  },
  events: {},
})
