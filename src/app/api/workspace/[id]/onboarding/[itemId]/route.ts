// Onboarding del cliente — PATCH de un ítem (status/owner/notes/due_date).
// Auth con requireWorkspaceMember + Zod, mismo patrón que los endpoints
// de workspace existentes.

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readJsonBody,
  requireWorkspaceMember,
} from "@/lib/auth/workspace-access";
import { updateItem } from "@/features/onboarding-cliente/services/onboarding.service";

const ItemIdSchema = z.string().uuid();

const PatchSchema = z
  .object({
    status: z.enum(["pendiente", "enviado", "recibido", "no_aplica"]).optional(),
    owner: z.enum(["nosotros", "cliente"]).optional(),
    notes: z.string().max(2000).nullable().optional(),
    due_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "El patch no puede estar vacío",
  });

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> },
): Promise<NextResponse> {
  const { id: workspaceId, itemId } = await params;

  const auth = await requireWorkspaceMember(workspaceId);
  if (!auth.ok) return auth.response;

  if (!ItemIdSchema.safeParse(itemId).success) {
    return NextResponse.json({ error: "Ítem inválido" }, { status: 400 });
  }

  const body = await readJsonBody(req);
  if (!body.ok) return body.response;

  const parsed = PatchSchema.safeParse(body.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Cuerpo inválido: solo se aceptan status, owner, notes y due_date" },
      { status: 400 },
    );
  }

  try {
    const item = await updateItem(workspaceId, itemId, parsed.data);
    return NextResponse.json({ item });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("no encontrado")) {
      return NextResponse.json({ error: "Ítem no encontrado" }, { status: 404 });
    }
    console.error("[onboarding] PATCH error:", err);
    return NextResponse.json(
      { error: "No se pudo actualizar el ítem" },
      { status: 500 },
    );
  }
}
