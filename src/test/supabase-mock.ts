/**
 * supabase-mock.ts — fake del cliente Supabase para tests unitarios.
 *
 * Los builders de supabase-js son "thenables" encadenables; acá cada llamada a
 * .from() consume la próxima respuesta de la cola (en orden de ejecución) y
 * registra tabla/método/argumentos para poder asertar sobre inserts y updates.
 */

export interface QueuedResponse {
  data?: unknown;
  error?: { message: string; code?: string } | null;
}

export interface RecordedCall {
  table: string;
  method: string;
  args: unknown[];
}

const CHAIN_METHODS = [
  "select",
  "insert",
  "update",
  "upsert",
  "delete",
  "eq",
  "neq",
  "in",
  "not",
  "gte",
  "lte",
  "filter",
  "order",
  "limit",
  "maybeSingle",
  "single",
] as const;

export function createSupabaseMock() {
  const queue: QueuedResponse[] = [];
  const calls: RecordedCall[] = [];

  function makeBuilder(table: string) {
    // Cada from() consume UNA respuesta, sin importar cuántos métodos encadene.
    const response = queue.shift() ?? { data: null, error: null };
    const builder: Record<string, unknown> = {};
    for (const method of CHAIN_METHODS) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return builder;
      };
    }
    builder.then = (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown,
    ) =>
      Promise.resolve({ data: null, error: null, ...response }).then(
        resolve,
        reject,
      );
    return builder;
  }

  const client = {
    from: (table: string) => makeBuilder(table),
    rpc: (name: string, args?: unknown) => {
      calls.push({ table: `rpc:${name}`, method: "rpc", args: [args] });
      const response = queue.shift() ?? { data: null, error: null };
      return Promise.resolve({ data: null, error: null, ...response });
    },
  };

  return { client, queue, calls };
}

export type SupabaseMock = ReturnType<typeof createSupabaseMock>;
