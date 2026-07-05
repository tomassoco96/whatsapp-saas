"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IntegrationSection } from "./integration-section";

/** Subconjunto de IntegrationData que usa esta sección (evita import circular). */
type TiendanubeInitial = {
  credentials: Record<string, string>;
  config: Record<string, unknown>;
};

/**
 * Formulario de conexión de Tiendanube: store ID + access token (por ahora
 * token manual del operador; el OAuth de app pública queda para más adelante).
 * Espejo de WooCommerceSection, sin recovery de carritos.
 */
export function TiendanubeSection({
  workspaceId,
  initial,
  onSaved,
}: {
  workspaceId: string;
  initial: TiendanubeInitial | undefined;
  onSaved: () => void;
}) {
  const [storeId, setStoreId] = useState(
    initial?.config?.store_id !== undefined
      ? String(initial.config.store_id)
      : "",
  );
  const [storeUrl, setStoreUrl] = useState(
    (initial?.config?.store_url as string | undefined) ?? "",
  );
  const [accessToken, setAccessToken] = useState(
    initial?.credentials?.tn_access_token ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  async function handleTest() {
    setTesting(true);
    try {
      const res = await fetch(
        `/api/workspace/${workspaceId}/integrations/tiendanube/test`,
        { method: "POST" },
      );
      const json = (await res.json()) as {
        ok: boolean;
        storeOk?: boolean;
        ordersOk?: boolean | null;
        error?: string;
      };
      if (json.ok) {
        toast.success("Tiendanube conectado — catálogo y pedidos OK");
      } else {
        toast.error(json.error ?? "No se pudo conectar con la tienda");
      }
    } catch {
      toast.error("Error de red al probar la conexión");
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!/^\d+$/.test(storeId.trim())) {
      toast.error("El Store ID de Tiendanube es numérico (ej: 123456)");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/integrations`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "tiendanube",
          credentials: { tn_access_token: accessToken },
          config: {
            store_id: storeId.trim(),
            store_url: storeUrl.trim().replace(/\/$/, ""),
          },
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (json.ok) {
        toast.success("Configuración de Tiendanube guardada");
        onSaved();
      } else {
        toast.error(json.error ?? "Error al guardar");
      }
    } catch {
      toast.error("Error de red al guardar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <IntegrationSection
      title="Tiendanube (e-commerce)"
      description="Catálogo y estado de pedidos de la tienda Nube."
    >
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="tn-store-id">Store ID</Label>
            <Input
              id="tn-store-id"
              placeholder="123456"
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tn-access-token">Access token</Label>
            <Input
              id="tn-access-token"
              type="password"
              placeholder="Token de la app"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="tn-store-url">URL pública de la tienda (https)</Label>
          <Input
            id="tn-store-url"
            type="url"
            placeholder="https://mitienda.mitiendanube.com"
            value={storeUrl}
            onChange={(e) => setStoreUrl(e.target.value)}
          />
        </div>
        <p className="text-xs text-muted-foreground -mt-2">
          El Store ID y el token salen de la app creada en el panel de partners
          de Tiendanube (scopes read_products y read_orders). La URL pública se
          usa para armar los links de productos. Recordá habilitar las tools{" "}
          <span className="font-mono">buscar_producto</span> y{" "}
          <span className="font-mono">estado_pedido</span> en la pestaña Tools.
        </p>

        <div className="flex items-center gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleTest}
            disabled={testing}
            aria-busy={testing}
          >
            {testing && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />
            )}
            Probar conexión
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={saving}
            aria-busy={saving}
          >
            {saving && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />
            )}
            Guardar
          </Button>
        </div>
      </div>
    </IntegrationSection>
  );
}
