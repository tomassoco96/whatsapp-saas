import { describe, it, expect } from "vitest";
import {
  canTransition,
  transition,
  aiShouldRespond,
  detectsHandoffTrigger,
  TransitionError,
  type ConversationState,
} from "./state-machine";

describe("canTransition", () => {
  it("permite ai_active → handoff_pending", () => {
    expect(canTransition("ai_active", "handoff_pending")).toBe(true);
  });

  it("permite handoff_pending → human_active y → ai_active", () => {
    expect(canTransition("handoff_pending", "human_active")).toBe(true);
    expect(canTransition("handoff_pending", "ai_active")).toBe(true);
  });

  it("closed es terminal: no permite salir a ningún estado", () => {
    const targets: ConversationState[] = [
      "ai_active",
      "human_active",
      "handoff_pending",
      "waiting_reply",
      "paused",
      "closed",
    ];
    for (const to of targets) {
      expect(canTransition("closed", to)).toBe(false);
    }
  });

  it("rechaza waiting_reply → handoff_pending (no definida)", () => {
    expect(canTransition("waiting_reply", "handoff_pending")).toBe(false);
  });

  it("todo estado no terminal puede llegar a closed", () => {
    const froms: ConversationState[] = [
      "ai_active",
      "human_active",
      "handoff_pending",
      "waiting_reply",
      "paused",
    ];
    for (const from of froms) {
      expect(canTransition(from, "closed")).toBe(true);
    }
  });
});

describe("transition", () => {
  it("devuelve el estado destino cuando la transición es válida", () => {
    expect(transition("ai_active", "human_active")).toBe("human_active");
  });

  it("lanza TransitionError en transición inválida", () => {
    expect(() => transition("closed", "ai_active")).toThrow(TransitionError);
    expect(() => transition("closed", "ai_active")).toThrow(
      "Invalid transition: closed → ai_active",
    );
  });
});

describe("aiShouldRespond", () => {
  it("solo responde en ai_active", () => {
    expect(aiShouldRespond("ai_active")).toBe(true);
    const silent: ConversationState[] = [
      "human_active",
      "handoff_pending",
      "waiting_reply",
      "paused",
      "closed",
    ];
    for (const s of silent) {
      expect(aiShouldRespond(s)).toBe(false);
    }
  });
});

describe("detectsHandoffTrigger", () => {
  it("detecta frases directas", () => {
    expect(detectsHandoffTrigger("quiero hablar con alguien")).toBe(true);
    expect(detectsHandoffTrigger("necesito un agente humano")).toBe(true);
    expect(detectsHandoffTrigger("me atiende una persona real?")).toBe(true);
  });

  it("es insensible a mayúsculas y tildes", () => {
    expect(detectsHandoffTrigger("QUIERO HABLAR con ALGUIEN")).toBe(true);
    expect(detectsHandoffTrigger("comuníquenme con un HUMANO")).toBe(true);
  });

  it("no dispara con mensajes normales de compra", () => {
    expect(detectsHandoffTrigger("hola, tienen stock de la remera azul?")).toBe(
      false,
    );
    expect(detectsHandoffTrigger("cuánto sale el envío a Córdoba?")).toBe(
      false,
    );
  });

  it("dispara con la palabra suelta 'agente' (comportamiento actual, documentado)", () => {
    // Nota: "agente" solo también matchea dentro de palabras más largas; si esto
    // genera falsos positivos en producción, ajustar HANDOFF_PHRASES con word
    // boundaries — este test fija el comportamiento vigente.
    expect(detectsHandoffTrigger("pasame con un agente")).toBe(true);
  });
});
