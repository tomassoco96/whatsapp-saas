/**
 * supabase-fake-db.ts — fake en memoria del cliente Supabase para el smoke E2E.
 *
 * A diferencia de supabase-mock.ts (cola FIFO, ideal para tests unitarios de un
 * servicio), este fake mantiene tablas en memoria y APLICA los filtros
 * .eq/.in/.gte/... — necesario para el smoke E2E donde un solo flujo encadena
 * ~25 queries de servicios distintos y ordenar una cola FIFO sería inmantenible.
 *
 * Soporta el subconjunto de PostgREST que usa el camino crítico:
 *   select (sin proyección de columnas: devuelve la fila entera),
 *   insert / update / upsert (con onConflict + ignoreDuplicates) / delete,
 *   eq, neq, in, gte, lte, lt, not("col","is",null), filter("payload->>k","eq",v),
 *   or (NO-OP: no filtra — suficiente para el smoke), order, limit,
 *   single / maybeSingle, y rpc() con handlers registrables.
 */

export type FakeRow = Record<string, unknown>;

export interface FakeRecordedCall {
  table: string;
  method: string;
  args: unknown[];
}

export interface FakeRpcResult {
  data?: unknown;
  error?: { message: string; code?: string } | null;
}

interface BuilderState {
  op: "select" | "insert" | "update" | "upsert" | "delete";
  payload: FakeRow | FakeRow[] | null;
  upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } | null;
  filters: Array<(row: FakeRow) => boolean>;
  order: { col: string; ascending: boolean } | null;
  limit: number | null;
  single: boolean;
  maybeSingle: boolean;
}

/** Lee "col" o "payload->>key" de una fila. */
function readCol(row: FakeRow, col: string): unknown {
  if (col.includes("->>")) {
    const [base, key] = col.split("->>");
    const obj = row[base];
    if (obj && typeof obj === "object") {
      return (obj as FakeRow)[key];
    }
    return undefined;
  }
  return row[col];
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const as = String(a ?? "");
  const bs = String(b ?? "");
  return as < bs ? -1 : as > bs ? 1 : 0;
}

const NO_ROWS_ERROR = {
  code: "PGRST116",
  message: "JSON object requested, multiple (or no) rows returned",
};

export function createFakeDb() {
  const tables: Record<string, FakeRow[]> = {};
  const calls: FakeRecordedCall[] = [];
  const rpcHandlers: Record<string, (args: unknown) => FakeRpcResult> = {};
  /** Defaults de columnas al insertar (imita defaults del schema Postgres). */
  const defaults: Record<string, () => FakeRow> = {
    conversations: () => ({ state: "ai_active", ai_enabled: true }),
    contacts: () => ({ opt_in: false, tags: [] }),
    messages: () => ({ status: "queued", meta: {} }),
    message_batches: () => ({ meta: {} }),
  };

  let idCounter = 0;
  const baseTime = Date.now();
  function nextId(table: string): string {
    idCounter += 1;
    return `${table}-${idCounter}`;
  }
  function nextCreatedAt(): string {
    // Monótono para que order("created_at") sea estable dentro de un test.
    idCounter += 1;
    return new Date(baseTime + idCounter).toISOString();
  }

  function rowsOf(table: string): FakeRow[] {
    if (!tables[table]) tables[table] = [];
    return tables[table];
  }

  function insertRow(table: string, payload: FakeRow): FakeRow {
    const base = defaults[table]?.() ?? {};
    const row: FakeRow = {
      id: nextId(table),
      created_at: nextCreatedAt(),
      updated_at: new Date().toISOString(),
      ...base,
      ...payload,
    };
    rowsOf(table).push(row);
    return row;
  }

  function makeBuilder(table: string) {
    const state: BuilderState = {
      op: "select",
      payload: null,
      upsertOpts: null,
      filters: [],
      order: null,
      limit: null,
      single: false,
      maybeSingle: false,
    };

    function record(method: string, args: unknown[]) {
      calls.push({ table, method, args });
    }

    function matching(): FakeRow[] {
      return rowsOf(table).filter((row) =>
        state.filters.every((f) => f(row)),
      );
    }

    function execute(): { data: unknown; error: unknown } {
      if (state.op === "insert") {
        const payloads = Array.isArray(state.payload)
          ? state.payload
          : [state.payload ?? {}];
        const inserted = payloads.map((p) => insertRow(table, p));
        return finish(inserted);
      }

      if (state.op === "upsert") {
        const payloads = Array.isArray(state.payload)
          ? state.payload
          : [state.payload ?? {}];
        const conflictCols = (state.upsertOpts?.onConflict ?? "")
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
        const returned: FakeRow[] = [];
        for (const p of payloads) {
          const existing =
            conflictCols.length > 0
              ? rowsOf(table).find((row) =>
                  conflictCols.every((c) => row[c] === p[c]),
                )
              : undefined;
          if (existing) {
            if (state.upsertOpts?.ignoreDuplicates) continue; // DO NOTHING
            Object.assign(existing, p, {
              updated_at: new Date().toISOString(),
            });
            returned.push(existing);
          } else {
            returned.push(insertRow(table, p));
          }
        }
        return finish(returned);
      }

      if (state.op === "update") {
        const rows = matching();
        for (const row of rows) {
          Object.assign(row, state.payload ?? {});
        }
        return finish(rows);
      }

      if (state.op === "delete") {
        const rows = matching();
        tables[table] = rowsOf(table).filter((r) => !rows.includes(r));
        return finish(rows);
      }

      // select
      let rows = matching();
      if (state.order) {
        const { col, ascending } = state.order;
        rows = [...rows].sort(
          (a, b) => compare(readCol(a, col), readCol(b, col)) * (ascending ? 1 : -1),
        );
      }
      if (state.limit !== null) rows = rows.slice(0, state.limit);
      return finish(rows);
    }

    function finish(rows: FakeRow[]): { data: unknown; error: unknown } {
      // Copias superficiales para que mutaciones del caller no toquen la "DB".
      const out = rows.map((r) => ({ ...r }));
      if (state.single) {
        if (out.length !== 1) return { data: null, error: NO_ROWS_ERROR };
        return { data: out[0], error: null };
      }
      if (state.maybeSingle) {
        return { data: out[0] ?? null, error: null };
      }
      return { data: out, error: null };
    }

    const builder: Record<string, unknown> = {
      select: (...args: unknown[]) => {
        record("select", args);
        return builder;
      },
      insert: (payload: FakeRow | FakeRow[]) => {
        record("insert", [payload]);
        state.op = "insert";
        state.payload = payload;
        return builder;
      },
      update: (payload: FakeRow) => {
        record("update", [payload]);
        state.op = "update";
        state.payload = payload;
        return builder;
      },
      upsert: (
        payload: FakeRow | FakeRow[],
        opts?: { onConflict?: string; ignoreDuplicates?: boolean },
      ) => {
        record("upsert", [payload, opts]);
        state.op = "upsert";
        state.payload = payload;
        state.upsertOpts = opts ?? null;
        return builder;
      },
      delete: () => {
        record("delete", []);
        state.op = "delete";
        return builder;
      },
      eq: (col: string, val: unknown) => {
        record("eq", [col, val]);
        state.filters.push((row) => readCol(row, col) === val);
        return builder;
      },
      neq: (col: string, val: unknown) => {
        record("neq", [col, val]);
        state.filters.push((row) => readCol(row, col) !== val);
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        record("in", [col, vals]);
        state.filters.push((row) => vals.includes(readCol(row, col)));
        return builder;
      },
      gte: (col: string, val: unknown) => {
        record("gte", [col, val]);
        state.filters.push((row) => compare(readCol(row, col), val) >= 0);
        return builder;
      },
      lte: (col: string, val: unknown) => {
        record("lte", [col, val]);
        state.filters.push((row) => compare(readCol(row, col), val) <= 0);
        return builder;
      },
      lt: (col: string, val: unknown) => {
        record("lt", [col, val]);
        state.filters.push((row) => compare(readCol(row, col), val) < 0);
        return builder;
      },
      not: (col: string, op: string, val: unknown) => {
        record("not", [col, op, val]);
        if (op === "is" && val === null) {
          state.filters.push((row) => readCol(row, col) != null);
        }
        return builder;
      },
      filter: (col: string, op: string, val: unknown) => {
        record("filter", [col, op, val]);
        if (op === "eq") {
          state.filters.push((row) => readCol(row, col) === val);
        }
        return builder;
      },
      // NO-OP deliberado: getConversationHistory usa .or("batch_id.is.null,...")
      // para excluir el batch en curso; para el smoke no filtrar es inocuo.
      or: (...args: unknown[]) => {
        record("or", args);
        return builder;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        record("order", [col, opts]);
        state.order = { col, ascending: opts?.ascending !== false };
        return builder;
      },
      limit: (n: number) => {
        record("limit", [n]);
        state.limit = n;
        return builder;
      },
      single: () => {
        record("single", []);
        state.single = true;
        return builder;
      },
      maybeSingle: () => {
        record("maybeSingle", []);
        state.maybeSingle = true;
        return builder;
      },
      then: (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
      ) => Promise.resolve(execute()).then(resolve, reject),
    };

    return builder;
  }

  const client = {
    from: (table: string) => makeBuilder(table),
    rpc: (name: string, args?: unknown) => {
      calls.push({ table: `rpc:${name}`, method: "rpc", args: [args] });
      const handler = rpcHandlers[name];
      const result = handler ? handler(args) : {};
      return Promise.resolve({ data: null, error: null, ...result });
    },
  };

  return { client, tables, calls, rpcHandlers, defaults };
}

export type FakeDb = ReturnType<typeof createFakeDb>;
