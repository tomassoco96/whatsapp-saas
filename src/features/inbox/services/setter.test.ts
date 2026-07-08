import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: () => ({ chat: () => "model" }) }));
vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { evaluateLead, type SetterConfig } from "./setter";
import { generateObject } from "ai";

const mockGenerate = vi.mocked(generateObject);

const CONFIG: SetterConfig = {
  id: "cfg1",
  name: "Mayorista",
  enabled: true,
  questions: [
    { id: "razon_social", text: "Razón social", type: "open", weight: 10 },
    { id: "cuit", text: "CUIT", type: "open", weight: 10 },
  ],
  knockout_rules: [
    { question_id: "razon_social", condition: "empty", action: "disqualify" },
    { question_id: "cuit", condition: "empty", action: "disqualify" },
  ],
  scoring: { threshold: 30, max_score: 49 },
  post_action: { type: "handoff" },
};

function llmSays(over: Record<string, unknown> = {}) {
  mockGenerate.mockResolvedValue({
    object: {
      score: 0,
      qualified: false,
      knocked_out: true,
      knockout_reason: "no dio razón social ni CUIT",
      summary: "sin datos",
      ...over,
    },
  } as unknown as Awaited<ReturnType<typeof generateObject>>);
}

beforeEach(() => vi.clearAllMocks());

describe("evaluateLead — guard de knockout prematuro", () => {
  it("con un solo turno del usuario NUNCA descalifica, aunque el LLM diga que sí", async () => {
    // Este es el caso real: el lead escribe "Hola" y las reglas de knockout
    // (razón social vacía) harían que el evaluador lo mate antes de preguntarle.
    llmSays();

    const result = await evaluateLead(CONFIG, "user: Hola");

    expect(result.knocked_out).toBe(false);
    expect(result.knockout_reason).toBeNull();
    expect(result.qualified).toBe(false); // score 0 < threshold: no calificado, pero vivo
  });

  it("con dos turnos del usuario sí respeta el knockout del evaluador", async () => {
    llmSays({ knockout_reason: "dijo que no tiene CUIT" });

    const result = await evaluateLead(
      CONFIG,
      "user: Hola\nassistant: Necesito tu CUIT\nuser: No tengo CUIT, compro en negro",
    );

    expect(result.knocked_out).toBe(true);
    expect(result.knockout_reason).toBe("dijo que no tiene CUIT");
    expect(result.qualified).toBe(false);
  });

  it("un lead sobre el umbral califica cuando no hay knockout", async () => {
    llmSays({ score: 40, knocked_out: false, knockout_reason: null });

    const result = await evaluateLead(
      CONFIG,
      "user: Hola\nassistant: Razón social?\nuser: Ferretería El Tornillo SRL, CUIT 20-12345678-6",
    );

    expect(result.knocked_out).toBe(false);
    expect(result.qualified).toBe(true);
  });

  it("un knockout siempre gana sobre un score alto", async () => {
    llmSays({ score: 90, knocked_out: true });

    const result = await evaluateLead(
      CONFIG,
      "user: a\nassistant: b\nuser: c",
    );

    expect(result.qualified).toBe(false);
  });

  it("el prompt le dice al evaluador que 'falta el dato' no es knockout", async () => {
    llmSays({ knocked_out: false });

    await evaluateLead(CONFIG, "user: Hola\nassistant: hola\nuser: che");

    const prompt = (mockGenerate.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("is NOT a knockout");
    expect(prompt).toContain("POSITIVE EVIDENCE");
  });
});
