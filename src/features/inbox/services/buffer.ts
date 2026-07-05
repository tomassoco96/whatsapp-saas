// buffer.ts — fachada pública del buffer de ráfagas (regla <500 líneas).
// La implementación vive en módulos cohesivos:
//   - buffer-types.ts    → tipos y constantes compartidos
//   - buffer-enqueue.ts  → upsertBatch (encolado de mensajes entrantes)
//   - buffer-context.ts  → armado del contexto IA (historial, prompt, costos, modelo)
//   - buffer-process.ts  → processNextBatch (claim, decisión, IA, envío, dead-letter)
// Los imports existentes (`@/features/inbox/services/buffer`) siguen funcionando.

export { upsertBatch } from "./buffer-enqueue";
export { processNextBatch } from "./buffer-process";
export type { ProcessBatchResult } from "./buffer-types";
