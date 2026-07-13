// Marks a conversation as read — resets unread_count when the thread is opened.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createSbClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // 1. Auth
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const { id: conversationId } = await params;

  // 2. RLS-scoped read proves the user is a member of the conversation's workspace
  const { data: conv } = await supabase
    .from("conversations")
    .select("id, unread_count")
    .eq("id", conversationId)
    .maybeSingle();

  if (!conv) {
    return NextResponse.json(
      { error: "Conversación no encontrada" },
      { status: 404 },
    );
  }

  if (conv.unread_count === 0) {
    return NextResponse.json({ ok: true });
  }

  // 3. Reset via service role: the update policy only covers admins/managers/
  // assignees, but any member who can view the thread may clear its badge.
  const svc = createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { error } = await svc
    .from("conversations")
    .update({ unread_count: 0 })
    .eq("id", conversationId);

  if (error) {
    console.error("[POST /api/conversations/[id]/read]:", error.message);
    return NextResponse.json(
      { error: "Error interno del servidor" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
