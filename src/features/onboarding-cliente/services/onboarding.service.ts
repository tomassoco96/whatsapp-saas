// Servicio del onboarding del cliente por workspace.
// Mismo patrón que reports/services/monthly-report.ts: service role para
// leer/escribir (el filtro por workspace_id es OBLIGATORIO en cada query),
// funciones puras exportadas para test (computeProgress, sanitizePatch).
// SOLO llamar server-side (páginas/API routes ya autorizadas con
// requireWorkspaceMember): usa SUPABASE_SERVICE_ROLE_KEY.

import { createClient as createSbClient } from "@supabase/supabase-js";
import {
  ONBOARDING_OWNERS,
  ONBOARDING_SEED_ITEMS,
  ONBOARDING_STATUSES,
  type OnboardingItemKind,
  type OnboardingItemOwner,
  type OnboardingItemStatus,
} from "./seed-items";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

const TABLE = "workspace_onboarding_items";

export interface OnboardingItem {
  id: string;
  workspace_id: string;
  section: string;
  label: string;
  detail: string | null;
  kind: OnboardingItemKind;
  status: OnboardingItemStatus;
  owner: OnboardingItemOwner;
  /** Fecha límite YYYY-MM-DD o null. */
  due_date: string | null;
  notes: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// ── Progreso (función pura, exportada para test) ────────────────────────────

export interface OnboardingProgress {
  total: number;
  /** Ítems cerrados: status 'recibido' o 'no_aplica'. */
  done: number;
  /** 0-100, redondeado. 0 si no hay ítems. */
  percent: number;
}

export function computeProgress(
  items: Array<Pick<OnboardingItem, "status">>,
): OnboardingProgress {
  const total = items.length;
  const done = items.filter(
    (i) => i.status === "recibido" || i.status === "no_aplica",
  ).length;
  return {
    total,
    done,
    percent: total > 0 ? Math.round((done / total) * 100) : 0,
  };
}

// ── Lectura + seed lazy ─────────────────────────────────────────────────────

/**
 * Devuelve los ítems de onboarding del workspace ordenados por sort_order.
 * Si el workspace todavía no tiene ítems, inserta el template estándar
 * (ONBOARDING_SEED_ITEMS) y devuelve las filas recién creadas.
 */
export async function getOrSeedItems(
  workspaceId: string,
): Promise<OnboardingItem[]> {
  const supabase = svc();

  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("sort_order", { ascending: true });

  if (error) throw new Error(`onboarding items: ${error.message}`);

  const existing = (data as OnboardingItem[] | null) ?? [];
  if (existing.length > 0) return existing;

  const rows = ONBOARDING_SEED_ITEMS.map((item) => ({
    workspace_id: workspaceId,
    ...item,
  }));

  const { data: inserted, error: insertError } = await supabase
    .from(TABLE)
    .insert(rows)
    .select("*");

  if (insertError) {
    throw new Error(`onboarding seed: ${insertError.message}`);
  }

  return (((inserted as OnboardingItem[] | null) ?? []) as OnboardingItem[])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);
}

// ── Update acotado ──────────────────────────────────────────────────────────

export interface OnboardingItemPatch {
  status?: OnboardingItemStatus;
  owner?: OnboardingItemOwner;
  /** null limpia las notas. */
  notes?: string | null;
  /** YYYY-MM-DD; null limpia la fecha. */
  due_date?: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTES_MAX = 2000;

/**
 * Filtra el patch a los ÚNICOS campos editables (status, owner, notes,
 * due_date) con valores válidos; descarta silenciosamente todo lo demás
 * (label, section, kind, etc. no se tocan nunca). Pura, exportada para test.
 */
export function sanitizePatch(
  patch: Record<string, unknown>,
): Partial<OnboardingItemPatch> {
  const out: Partial<OnboardingItemPatch> = {};

  if (
    typeof patch.status === "string" &&
    (ONBOARDING_STATUSES as readonly string[]).includes(patch.status)
  ) {
    out.status = patch.status as OnboardingItemStatus;
  }

  if (
    typeof patch.owner === "string" &&
    (ONBOARDING_OWNERS as readonly string[]).includes(patch.owner)
  ) {
    out.owner = patch.owner as OnboardingItemOwner;
  }

  if (patch.notes === null) {
    out.notes = null;
  } else if (typeof patch.notes === "string") {
    out.notes = patch.notes.slice(0, NOTES_MAX);
  }

  if (patch.due_date === null) {
    out.due_date = null;
  } else if (typeof patch.due_date === "string" && DATE_RE.test(patch.due_date)) {
    out.due_date = patch.due_date;
  }

  return out;
}

/**
 * Actualiza un ítem del workspace. Solo admite los campos de
 * OnboardingItemPatch (el resto se descarta). Lanza si el patch queda vacío
 * o si el ítem no existe en ese workspace.
 */
export async function updateItem(
  workspaceId: string,
  itemId: string,
  patch: OnboardingItemPatch,
): Promise<OnboardingItem> {
  const fields = sanitizePatch(patch as Record<string, unknown>);
  if (Object.keys(fields).length === 0) {
    throw new Error("Patch vacío: nada para actualizar");
  }

  const supabase = svc();

  const { data, error } = await supabase
    .from(TABLE)
    .update(fields)
    .eq("id", itemId)
    .eq("workspace_id", workspaceId)
    .select("*")
    .maybeSingle();

  if (error) throw new Error(`onboarding update: ${error.message}`);
  if (!data) throw new Error("Ítem de onboarding no encontrado en este workspace");

  return data as OnboardingItem;
}
