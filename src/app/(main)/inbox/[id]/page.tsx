import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { InboxLayout } from "@/features/inbox/components/inbox-layout";
import { ChatThread } from "@/features/inbox/components/chat-thread";
import type {
  ConversationWithContact,
  ConversationRow,
  ContactRow,
  MessageRow,
} from "@/features/inbox/types";
import type { WorkspaceRole } from "@/features/inbox/hooks/use-role";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function InboxDetailPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = await createClient();

  // 1. Authenticate
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // 2. Fetch the conversation + contact (RLS scopes it to the user's workspaces)
  const { data: convData } = await supabase
    .from("conversations")
    .select("*, contact:contacts(*)")
    .eq("id", id)
    .single();

  if (!convData) notFound();

  const convWithContact = convData as ConversationRow & { contact: ContactRow };

  // 3. Role for THIS conversation's workspace. With multiple memberships, an
  // arbitrary first row could belong to another workspace and the sidebar
  // would render empty (and the role would be wrong).
  const { data: membership } = await supabase
    .from("memberships")
    .select("workspace_id, role")
    .eq("user_id", user.id)
    .eq("workspace_id", convWithContact.workspace_id)
    .eq("is_active", true)
    .maybeSingle();

  const role = (membership?.role ?? "agent") as WorkspaceRole;

  // 4. Fetch messages (ASC, limit 100)
  const { data: messagesData } = await supabase
    .from("messages")
    .select("*, sender:users!sender_user_id(full_name, avatar_url)")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true })
    .limit(100);

  const messages = (messagesData ?? []) as MessageRow[];

  // 5. Fetch sidebar conversations (the conversation's workspace, for InboxLayout)
  const { data: conversations } = await supabase
    .from("conversations")
    .select("*, contact:contacts(*)")
    .eq("workspace_id", convWithContact.workspace_id)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(50);

  const rows = (conversations ?? []) as (ConversationRow & {
    contact: ContactRow;
  })[];

  const convIds = rows.map((c) => c.id);
  const lastMessageMap = new Map<
    string,
    Pick<MessageRow, "body" | "direction" | "created_at">
  >();

  if (convIds.length > 0) {
    const { data: recentMessages } = await supabase
      .from("messages")
      .select("conversation_id, body, direction, created_at")
      .in("conversation_id", convIds)
      .order("created_at", { ascending: false });

    if (recentMessages) {
      for (const msg of recentMessages) {
        if (!lastMessageMap.has(msg.conversation_id)) {
          lastMessageMap.set(msg.conversation_id, {
            body: msg.body,
            direction: msg.direction,
            created_at: msg.created_at,
          });
        }
      }
    }
  }

  const sidebarConversations: ConversationWithContact[] = rows.map((conv) => ({
    ...conv,
    last_message: lastMessageMap.get(conv.id) ?? null,
  }));

  const conversation: ConversationWithContact = {
    ...convWithContact,
    last_message:
      messages.length > 0
        ? {
            body: messages[messages.length - 1].body,
            direction: messages[messages.length - 1].direction,
            created_at: messages[messages.length - 1].created_at,
          }
        : null,
  };

  return (
    <InboxLayout
      conversations={sidebarConversations}
      workspaceId={convWithContact.workspace_id}
    >
      <ChatThread
        conversation={conversation}
        initialMessages={messages}
        currentUserId={user.id}
        role={role}
      />
    </InboxLayout>
  );
}
