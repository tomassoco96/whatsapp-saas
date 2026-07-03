import { describe, it, expect } from "vitest";
import { formatWhatsAppMarkdown } from "./text-formatter";

describe("formatWhatsAppMarkdown", () => {
  it("convierte **bold** y __bold__ a *bold*", () => {
    expect(formatWhatsAppMarkdown("hola **mundo**")).toBe("hola *mundo*");
    expect(formatWhatsAppMarkdown("hola __mundo__")).toBe("hola *mundo*");
  });

  it("convierte headings a línea en negrita", () => {
    expect(formatWhatsAppMarkdown("## Horarios")).toBe("*Horarios*");
    expect(formatWhatsAppMarkdown("# Título #")).toBe("*Título*");
  });

  it("convierte ~~tachado~~ a ~tachado~", () => {
    expect(formatWhatsAppMarkdown("precio ~~$100~~ $80")).toBe(
      "precio ~$100~ $80",
    );
  });

  it("convierte links markdown a 'texto (url)'", () => {
    expect(
      formatWhatsAppMarkdown("mirá [el producto](https://tienda.com/p/1)"),
    ).toBe("mirá el producto (https://tienda.com/p/1)");
  });

  it("normaliza bullets * y + a '- ' sin romper *negrita*", () => {
    expect(formatWhatsAppMarkdown("* item uno\n+ item dos")).toBe(
      "- item uno\n- item dos",
    );
    // *negrita* al inicio de línea no tiene espacio tras el asterisco: se preserva
    expect(formatWhatsAppMarkdown("*importante* leer esto")).toBe(
      "*importante* leer esto",
    );
  });

  it("es idempotente sobre texto ya formateado para WhatsApp", () => {
    const wa = "*Horarios*\n- lunes a viernes\n_9 a 18_";
    expect(formatWhatsAppMarkdown(wa)).toBe(wa);
  });

  it("maneja string vacío sin romper", () => {
    expect(formatWhatsAppMarkdown("")).toBe("");
  });
});
