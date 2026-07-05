import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseMock, type SupabaseMock } from "@/test/supabase-mock";

const h = vi.hoisted(() => ({ mock: null as unknown as SupabaseMock }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => h.mock.client,
}));

// imports del módulo bajo test DESPUÉS de los vi.mock
import { notifyAlertWebhook, runHealthCheck } from "./health-alerts.service";

const NOW = new Date("2026-07-05T12:00:00.000Z");
const WS = [{ id: "ws-a", name: "Tienda Alfa", slug: "alfa" }];

function minsAgo(mins: number): string {
  return new Date(NOW.getTime() - mins * 60_000).toISOString();
}

const fetchMock = vi.fn();

beforeEach(() => {
  h.mock = createSupabaseMock();
  vi.clearAllMocks();
  fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/**
 * Orden FIFO de queries del orquestador (cada .from() consume UNA respuesta):
 * 1 workspaces · 2 message_batches · 3 messages · 4 events llm_usage ·
 * 5 events tool_call error · 6 workspace_alerts abiertas · luego escrituras.
 */
function pushBaseline(over: {
  batches?: unknown[];
  inbound?: unknown[];
  llm?: unknown[];
  toolErrors?: unknown[];
  open?: unknown[];
}) {
  h.mock.queue.push(
    { data: WS },
    { data: over.batches ?? [] },
    { data: over.inbound ?? [] },
    { data: over.llm ?? [] },
    { data: over.toolErrors ?? [] },
    { data: over.open ?? [] },
  );
}

describe("runHealthCheck", () => {
  it("sin workspaces activos devuelve ceros y no consulta el resto", async () => {
    h.mock.queue.push({ data: [] });

    const summary = await runHealthCheck(NOW);

    expect(summary).toEqual({ workspaces: 0, created: 0, updated: 0, resolved: 0 });
    expect(h.mock.calls.filter((c) => c.table !== "workspaces")).toEqual([]);
  });

  it("workspace sano: no inserta, no actualiza, no resuelve, no notifica", async () => {
    pushBaseline({
      inbound: [{ workspace_id: "ws-a", created_at: minsAgo(30) }],
    });

    const summary = await runHealthCheck(NOW);

    expect(summary).toEqual({ workspaces: 1, created: 0, updated: 0, resolved: 0 });
    const writes = h.mock.calls.filter(
      (c) => c.table === "workspace_alerts" && c.method !== "select" &&
        c.method !== "filter" && c.method !== "in",
    );
    expect(writes).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("buffer trabado crea alerta critical y notifica al webhook si hay env", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.test/alertas");
    pushBaseline({
      batches: [{ workspace_id: "ws-a", flush_at: minsAgo(20), created_at: minsAgo(21) }],
      inbound: [{ workspace_id: "ws-a", created_at: minsAgo(10) }],
    });
    // respuesta del insert (con created_at para el payload del webhook)
    h.mock.queue.push({
      data: [
        {
          id: "al-1",
          workspace_id: "ws-a",
          type: "buffer_trabado",
          severity: "critical",
          message: "1 mensaje(s) en el buffer...",
          created_at: NOW.toISOString(),
        },
      ],
    });

    const summary = await runHealthCheck(NOW);

    expect(summary.created).toBe(1);
    const insert = h.mock.calls.find(
      (c) => c.table === "workspace_alerts" && c.method === "insert",
    )!;
    const rows = insert.args[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspace_id: "ws-a",
      type: "buffer_trabado",
      severity: "critical",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.test/alertas");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      workspace: "Tienda Alfa",
      type: "buffer_trabado",
      severity: "critical",
      message: "1 mensaje(s) en el buffer...",
      created_at: NOW.toISOString(),
    });
  });

  it("sin ALERT_WEBHOOK_URL no notifica aunque haya alerta nueva", async () => {
    pushBaseline({
      toolErrors: [
        { workspace_id: "ws-a" },
        { workspace_id: "ws-a" },
        { workspace_id: "ws-a" },
      ],
    });
    h.mock.queue.push({ data: [{ id: "al-2", workspace_id: "ws-a", type: "errores_tools", severity: "warning", message: "m", created_at: NOW.toISOString() }] });

    const summary = await runHealthCheck(NOW);

    expect(summary.created).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dedupe: alerta abierta del mismo type se refresca en vez de duplicarse", async () => {
    pushBaseline({
      batches: [{ workspace_id: "ws-a", flush_at: minsAgo(15), created_at: minsAgo(16) }],
      open: [
        {
          id: "al-old",
          workspace_id: "ws-a",
          type: "buffer_trabado",
          severity: "critical",
          message: "viejo",
        },
      ],
    });
    h.mock.queue.push({ data: null }); // respuesta del update

    const summary = await runHealthCheck(NOW);

    expect(summary).toEqual({ workspaces: 1, created: 0, updated: 1, resolved: 0 });
    expect(
      h.mock.calls.find(
        (c) => c.table === "workspace_alerts" && c.method === "insert",
      ),
    ).toBeUndefined();
    const update = h.mock.calls.find(
      (c) => c.table === "workspace_alerts" && c.method === "update",
    )!;
    expect(update.args[0]).toMatchObject({ severity: "critical" });
    expect(fetchMock).not.toHaveBeenCalled(); // solo alertas NUEVAS notifican
  });

  it("auto-resolución: la condición dejó de cumplirse → setea resolved_at", async () => {
    pushBaseline({
      inbound: [{ workspace_id: "ws-a", created_at: minsAgo(5) }],
      open: [
        {
          id: "al-res",
          workspace_id: "ws-a",
          type: "silencio_anomalo",
          severity: "warning",
          message: "silencio",
        },
      ],
    });
    h.mock.queue.push({ data: null }); // respuesta del update de resolución

    const summary = await runHealthCheck(NOW);

    expect(summary).toEqual({ workspaces: 1, created: 0, updated: 0, resolved: 1 });
    const update = h.mock.calls.find(
      (c) => c.table === "workspace_alerts" && c.method === "update",
    )!;
    expect(update.args[0]).toEqual({ resolved_at: NOW.toISOString() });
    // la lectura de abiertas también usa .in (workspace_id); buscar la de id
    const resolveIn = h.mock.calls.find(
      (c) =>
        c.table === "workspace_alerts" &&
        c.method === "in" &&
        c.args[0] === "id",
    )!;
    expect(resolveIn.args).toEqual(["id", ["al-res"]]);
  });

  it("propaga el error si falla una query de datos", async () => {
    h.mock.queue.push(
      { data: WS },
      { data: null, error: { message: "batches caído" } },
      { data: [] },
      { data: [] },
      { data: [] },
      { data: [] },
    );

    await expect(runHealthCheck(NOW)).rejects.toThrow("batches caído");
  });
});

describe("notifyAlertWebhook", () => {
  const payload = {
    workspace: "Tienda Alfa",
    type: "buffer_trabado",
    severity: "critical",
    message: "trabado",
    created_at: NOW.toISOString(),
  };

  it("sin env no llama a fetch", async () => {
    await notifyAlertWebhook(payload);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("un fetch que falla no lanza (fire and forget)", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.test/alertas");
    fetchMock.mockRejectedValueOnce(new Error("red caída"));
    await expect(notifyAlertWebhook(payload)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
