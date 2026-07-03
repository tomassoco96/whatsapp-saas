import { z } from "zod";

/**
 * Contrato del webhook del plugin de carritos (BotSailor/CartBounty),
 * portado del motor v1.
 *
 * Solo `items` (no vacío) y `total` son obligatorios — el resto del payload
 * de los plugins es irregular, así que se acepta laxo y se normaliza luego:
 *  - `phone` se normaliza a E.164 AR en el servicio (puede quedar sin contacto).
 *  - `email` no se valida con estrictez para no rechazar carritos por un mail roto.
 *  - `abandoned_at` admite cualquier fecha parseable (los plugins varían el formato).
 */
const cartItemSchema = z.object({
  name: z.string().min(1),
  qty: z.coerce.number().int().positive(),
  price: z.coerce.number().nonnegative(),
  sku: z.string().optional(),
  url: z.string().optional(),
});

export const abandonedCartWebhookSchema = z.object({
  external_id: z.string().min(1).optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
  items: z.array(cartItemSchema).min(1, "Se requiere al menos un ítem"),
  total: z.coerce.number().nonnegative(),
  currency: z.string().optional(),
  checkout_url: z.string().optional(),
  abandoned_at: z
    .string()
    .refine(
      (s) => !Number.isNaN(Date.parse(s)),
      "abandoned_at debe ser una fecha ISO8601 válida",
    ),
});

export type AbandonedCartWebhook = z.infer<typeof abandonedCartWebhookSchema>;
