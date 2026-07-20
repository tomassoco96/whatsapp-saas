// buffer-types.ts — tipos y constantes compartidos por los módulos del buffer
// (buffer-enqueue / buffer-context / buffer-process). Sin lógica.

export const DEFAULT_SILENCE_MS = 30_000; // 30 seconds silence window
export const MAX_BATCH_RETRIES = 3;

// ──────────────────────────────────────────────────────────────────────────────
// Internal types
// ──────────────────────────────────────────────────────────────────────────────

export interface MessageBatch {
  id: string;
  workspace_id: string;
  conversation_id: string;
  status: "buffering" | "flushed" | "processing" | "processed" | "cancelled";
  silence_ms: number;
  flush_at: string;
  message_count: number;
  merged_text: string | null;
  /** Sellado cuando el turno ya se despachó: idempotencia anti re-envío. */
  dispatched_at: string | null;
  /** Reintento programado: el batch queda en 'processing' hasta este instante. */
  retry_after: string | null;
  meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BatchMessage {
  id: string;
  body: string | null;
  meta: Record<string, unknown> | null;
  type: string;
  created_at: string;
}

export interface ProcessBatchResult {
  processed: boolean;
  conversationId?: string;
  error?: string;
}
