// Template estándar del onboarding del cliente.
// Derivado del checklist canónico de requisitos (formulario-requisitos-onboarding
// del kit de replicación): secciones A-F + los textos que le mandamos al cliente.
// Se inserta lazy por workspace la primera vez que se consulta el onboarding
// (ver onboarding.service.ts → getOrSeedItems).

export const ONBOARDING_KINDS = [
  "pregunta_hecha",
  "entregable",
  "envio",
] as const;
export type OnboardingItemKind = (typeof ONBOARDING_KINDS)[number];

export const ONBOARDING_STATUSES = [
  "pendiente",
  "enviado",
  "recibido",
  "no_aplica",
] as const;
export type OnboardingItemStatus = (typeof ONBOARDING_STATUSES)[number];

export const ONBOARDING_OWNERS = ["nosotros", "cliente"] as const;
export type OnboardingItemOwner = (typeof ONBOARDING_OWNERS)[number];

/** Orden canónico de las secciones del checklist. */
export const ONBOARDING_SECTIONS = [
  "Negocio e identidad",
  "Plataforma e-commerce",
  "WhatsApp y Meta",
  "Políticas y datos sensibles",
  "Operación humana",
  "Recuperación de carritos",
  "Para enviar al cliente",
] as const;

export interface OnboardingSeedItem {
  section: string;
  label: string;
  /** Texto largo copiable (mensajes listos para WhatsApp en kind='envio'). */
  detail: string | null;
  kind: OnboardingItemKind;
  owner: OnboardingItemOwner;
  sort_order: number;
}

type SeedRow = Omit<OnboardingSeedItem, "sort_order">;

function pregunta(section: string, label: string): SeedRow {
  return { section, label, detail: null, kind: "pregunta_hecha", owner: "nosotros" };
}

function entregable(section: string, label: string): SeedRow {
  return { section, label, detail: null, kind: "entregable", owner: "cliente" };
}

function envio(section: string, label: string, detail: string): SeedRow {
  return { section, label, detail, kind: "envio", owner: "nosotros" };
}

// ── Textos copiables (listos para pegar en WhatsApp) ────────────────────────

const MSG_FORMULARIO = `¡Hola! ¿Cómo andás? Te paso el formulario de requisitos para armar tu agente de WhatsApp.
Son los datos y accesos que necesitamos para dejarlo funcionando: tono, políticas, medios de pago y credenciales de la tienda.
Ideal si lo completás antes de la reunión, así aprovechamos la llamada para lo importante.
Cualquier duda con algún punto, me escribís por acá y lo vemos juntos. ¡Gracias!`;

const MSG_TUTORIAL_WOO = `Te paso el paso a paso para generar las claves de WooCommerce que necesitamos para consultar pedidos:
1. Entrá a tu WordPress → WooCommerce → Ajustes → Avanzado → REST API.
2. Tocá "Añadir clave", poné de descripción "Agente WhatsApp" y elegí permisos de Lectura.
3. Tocá "Generar clave API" y copiá la Consumer key y el Consumer secret ANTES de salir de esa pantalla (después no se vuelven a mostrar).
4. Mandámelas por el canal que acordamos para credenciales.
Con eso el agente ya puede responder "¿dónde está mi pedido?" con datos reales. ¡Gracias!`;

const MSG_LOGO_CHATS = `¡Hola! Para que el agente hable como tu negocio necesito dos cosas:
1. El logo en PNG (si tenés versión con fondo transparente, mejor).
2. Un export de chats reales de WhatsApp con clientes (Ajustes → Chats → Exportar chat, sin archivos adjuntos) o, si no, la lista de preguntas frecuentes que ya tengan escrita.
Los chats son la mejor fuente: de ahí salen el tono y los casos reales de tus clientes.
Queda todo entre nosotros y se usa solo para entrenar tu agente. ¡Gracias!`;

const MSG_META_PORTFOLIO = `Te cuento un requisito importante: el agente usa la API oficial de WhatsApp, y Meta pide que el negocio tenga un portfolio comercial (Business Manager) verificado.
Si ya hacen anuncios en Facebook o Instagram, seguramente ya lo tienen: decime quién lo administra así coordinamos el acceso.
Si no lo tienen, se crea gratis en business.facebook.com y la verificación demora unos días, así que conviene arrancar ya.
Además necesitamos definir el número dedicado para el bot: si usamos el que atienden hoy, ese número deja de funcionar en la app común de WhatsApp (lo coordinamos juntos para que no pierdan nada).`;

// ── Template ────────────────────────────────────────────────────────────────

const TEMPLATE: SeedRow[] = [
  // A. Negocio e identidad — bloquea: prompt y biblia
  pregunta("Negocio e identidad", "Nombre comercial, URL de la tienda y rubro"),
  pregunta("Negocio e identidad", "Horarios de atención humana (días y horas)"),
  pregunta(
    "Negocio e identidad",
    "Tono deseado del agente (vos/usted, emojis sí/no, formal/cercano)",
  ),
  entregable("Negocio e identidad", "Logo en PNG (fondo transparente si hay)"),
  entregable(
    "Negocio e identidad",
    "Export de chats reales de WhatsApp o FAQ escrita (la fuente del tono y los casos reales)",
  ),

  // B. Plataforma e-commerce — bloquea: buscar_producto y estado_pedido
  pregunta(
    "Plataforma e-commerce",
    "Plataforma confirmada: WooCommerce, Tiendanube o Shopify",
  ),
  entregable(
    "Plataforma e-commerce",
    "WooCommerce: consumer key + secret de REST API v3 (read-only de pedidos alcanza)",
  ),
  entregable(
    "Plataforma e-commerce",
    "WooCommerce: usuario admin o acceso temporal al /wp-admin",
  ),
  entregable("Plataforma e-commerce", "Tiendanube: store_id + access token de la API"),
  entregable(
    "Plataforma e-commerce",
    "Shopify: dominio .myshopify.com + Admin API token (read_products, read_orders, read_customers)",
  ),
  pregunta(
    "Plataforma e-commerce",
    "Estados de pedido: ¿\"Completado\" es despachado o solo pago confirmado? ¿Qué estado habilita retiro?",
  ),
  pregunta(
    "Plataforma e-commerce",
    "¿El catálogo está al día en precios y stock? Si no, ¿quién lo actualiza y cuándo?",
  ),

  // C. WhatsApp y Meta — bloquea: el canal entero
  pregunta(
    "WhatsApp y Meta",
    "Número para el bot: ¿nuevo o el que usa hoy el negocio? (si está en uso, coordinar migración a la API)",
  ),
  entregable(
    "WhatsApp y Meta",
    "Acceso al Meta Business Manager o contacto de quien lo administra",
  ),
  pregunta("WhatsApp y Meta", "¿El negocio está verificado en Meta?"),
  pregunta("WhatsApp y Meta", "Nombre visible deseado del perfil (display name)"),
  entregable(
    "WhatsApp y Meta",
    "API key de YCloud (solo si la cuenta es del cliente; si es nuestra, marcar No aplica)",
  ),

  // D. Políticas y datos sensibles — bloquea: respuestas correctas del agente
  entregable(
    "Políticas y datos sensibles",
    "Medios de pago aceptados por escrito (recargos, descuentos, cuotas)",
  ),
  entregable(
    "Políticas y datos sensibles",
    "Datos bancarios para transferencias PEGADOS por escrito, nunca dictados (alias/CBU, titular, CUIT)",
  ),
  entregable(
    "Políticas y datos sensibles",
    "Política de envíos (zonas, costos, plazos, gratis desde)",
  ),
  entregable("Políticas y datos sensibles", "Política de cambios y devoluciones"),
  pregunta("Políticas y datos sensibles", "Promos vigentes y cómo se comunican"),
  pregunta(
    "Políticas y datos sensibles",
    "Datos que el agente NO puede dar nunca (dirección de depósito, teléfonos internos, etc.)",
  ),
  pregunta(
    "Políticas y datos sensibles",
    "Pedidos fuera de catálogo / mayoristas: ¿existen? ¿quién los cotiza?",
  ),

  // E. Operación humana — bloquea: derivación y comprobantes
  pregunta(
    "Operación humana",
    "¿Quién atiende las derivaciones del bot y en qué horario mira el inbox?",
  ),
  pregunta(
    "Operación humana",
    "¿Qué pasa fuera de horario? (mensaje de espera / promesa de respuesta)",
  ),
  pregunta(
    "Operación humana",
    "Flujo del comprobante de pago: ¿a quién se deriva cuando llega por el chat?",
  ),
  entregable("Operación humana", "Emails del cliente para acceso al panel (rol viewer o admin)"),
  entregable("Operación humana", "Email para recibir el reporte mensual"),

  // F. Recuperación de carritos (solo si contrató recovery)
  pregunta(
    "Recuperación de carritos",
    "¿Va a usar recuperación de carritos? ¿El checkout captura teléfono?",
  ),
  entregable(
    "Recuperación de carritos",
    "Acceso al WordPress para instalar el plugin de carritos (solo WooCommerce)",
  ),
  pregunta(
    "Recuperación de carritos",
    "Copy de los toques (2-3 mensajes) validado por el cliente en la reunión (someter a Meta hoy mismo)",
  ),
  pregunta("Recuperación de carritos", "Quiet hours (no molestar de __ a __ h) y timezone"),
  entregable(
    "Recuperación de carritos",
    "OK explícito del dueño para mensajes salientes a clientes reales (recovery apagado hasta tenerlo)",
  ),

  // Para enviar al cliente — textos copiables listos para WhatsApp
  envio(
    "Para enviar al cliente",
    "Mensaje: formulario de requisitos para completar",
    MSG_FORMULARIO,
  ),
  envio(
    "Para enviar al cliente",
    "Mensaje: tutorial de API keys de WooCommerce",
    MSG_TUTORIAL_WOO,
  ),
  envio(
    "Para enviar al cliente",
    "Mensaje: pedido de logo + export de chats",
    MSG_LOGO_CHATS,
  ),
  envio(
    "Para enviar al cliente",
    "Mensaje: portfolio comercial de Meta explicado",
    MSG_META_PORTFOLIO,
  ),
];

/** Ítems estándar del onboarding, con sort_order en pasos de 10. */
export const ONBOARDING_SEED_ITEMS: OnboardingSeedItem[] = TEMPLATE.map(
  (row, i) => ({ ...row, sort_order: (i + 1) * 10 }),
);
