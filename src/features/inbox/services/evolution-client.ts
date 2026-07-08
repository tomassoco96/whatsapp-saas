// ──────────────────────────────────────────────────────────────────────────────
// Evolution API client — canal WhatsApp no oficial (Baileys) para pruebas y
// clientes sin BSP. Mismo rol que ycloud-client.ts pero contra un servidor
// Evolution self-hosted (v2.x). Solo dispatch.ts debe llamar sendEvolutionText
// (SEC-04: single exit point).
// ──────────────────────────────────────────────────────────────────────────────

export class EvolutionError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "EvolutionError";
  }
}

export interface EvolutionConfig {
  /** URL base del servidor Evolution (ej. https://evolution.midominio.com) */
  serverUrl: string;
  /** API key global o de la instancia */
  apiKey: string;
  /** Nombre de la instancia (una por workspace/número) */
  instance: string;
}

export interface EvolutionSendResult {
  /** ID del mensaje asignado por WhatsApp (data.key.id) */
  id: string;
  status: string;
}

/** Normaliza el server URL (sin barra final) y arma la URL de un endpoint. */
function endpoint(cfg: EvolutionConfig, path: string): string {
  const base = cfg.serverUrl.replace(/\/+$/, "");
  return `${base}${path}`;
}

/**
 * Delay de tipeo "anti-robot": Evolution muestra presencia "escribiendo..."
 * durante el delay antes de entregar el mensaje. Escala con el largo del texto,
 * acotado para no demorar de más (1.5s a 8s).
 */
export function typingDelayMs(body: string): number {
  return Math.min(8000, Math.max(1500, 1000 + body.length * 25));
}

interface SendEvolutionTextParams extends EvolutionConfig {
  /** Destinatario en E.164 con o sin '+' */
  to: string;
  body: string;
  /** Milisegundos de presencia "escribiendo" antes de enviar. Default: según largo. */
  delayMs?: number;
}

/**
 * Envía un mensaje de texto vía Evolution API v2.
 * Lanza EvolutionError en respuestas no-2xx.
 */
export async function sendEvolutionText(
  params: SendEvolutionTextParams,
): Promise<EvolutionSendResult> {
  const { to, body, delayMs } = params;

  // Evolution espera el número sin '+' (formato JID: 549115555555)
  const number = to.replace(/^\+/, "");

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(
      endpoint(params, `/message/sendText/${encodeURIComponent(params.instance)}`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: params.apiKey,
        },
        body: JSON.stringify({
          number,
          text: body,
          delay: delayMs ?? typingDelayMs(body),
          linkPreview: true,
        }),
        signal: ctrl.signal,
      },
    );
  } finally {
    clearTimeout(t);
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  if (!response.ok) {
    throw new EvolutionError(
      response.status,
      responseBody,
      `Evolution API error ${response.status}`,
    );
  }

  const data = responseBody as {
    key?: { id?: string };
    status?: string;
  } | null;

  return {
    id: typeof data?.key?.id === "string" ? data.key.id : "",
    status: typeof data?.status === "string" ? data.status : "PENDING",
  };
}

/**
 * Chequeo de conexión: consulta el estado de la instancia.
 * Devuelve el estado ("open" = conectada a WhatsApp) o lanza EvolutionError.
 */
export async function fetchInstanceState(
  cfg: EvolutionConfig,
): Promise<{ state: string }> {
  const response = await fetch(
    endpoint(cfg, `/instance/connectionState/${encodeURIComponent(cfg.instance)}`),
    { headers: { apikey: cfg.apiKey }, cache: "no-store" },
  );

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  if (!response.ok) {
    throw new EvolutionError(
      response.status,
      responseBody,
      `Evolution API error ${response.status}`,
    );
  }

  const data = responseBody as { instance?: { state?: string } } | null;
  return { state: data?.instance?.state ?? "unknown" };
}
