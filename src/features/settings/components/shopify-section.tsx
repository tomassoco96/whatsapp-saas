"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IntegrationSection } from "./integration-section";

/** Subconjunto de IntegrationData que usa esta sección (evita import circular). */
type ShopifyInitial = {
  credentials: Record<string, string>;
  config: Record<string, unknown>;
};

/**
 * Formulario de conexión de Shopify: shop domain (xxx.myshopify.com) + Admin
 * API access token de una custom app. Espejo de WooCommerceSection, sin
 * recovery de carritos.
 */
export function ShopifySection({
  workspaceId,
  initial,
  onSaved,
}: {
  workspaceId: string;
  initial: ShopifyInitial | undefined;
  onSaved: () => void;
}) {
  const [shopDomain, setShopDomain] = useState(
    (initial?.config?.shop_domain as string | undefined) ?? "",
  );
  const [accessToken, setAccessToken] = useState(
    initial?.credentials?.shopify_access_token ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  async function handleTest() {
    setTesting(true);
    try {
      const res = await fetch(
        `/api/workspace/${workspaceId}/integrations/shopify/test`,
        { method: "POST" },
      );
      const json = (await res.json()) as {
        ok: boolean;
        storeOk?: boolean;
        ordersOk?: boolean | null;
        error?: string;
      };
      if (json.ok) {
        toast.success("Shopify conectado — catálogo y pedidos OK");
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
    const domain = shopDomain
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
      toast.error("El dominio debe tener el formato mitienda.myshopify.com");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/integrations`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "shopify",
          credentials: { shopify_access_token: accessToken },
          config: { shop_domain: domain },
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (json.ok) {
        toast.success("Configuración de Shopify guardada");
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
      title="Shopify (e-commerce)"
      description="Catálogo y estado de pedidos de la tienda Shopify."
    >
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="shopify-domain">Shop domain</Label>
            <Input
              id="shopify-domain"
              placeholder="mitienda.myshopify.com"
              value={shopDomain}
              onChange={(e) => setShopDomain(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="shopify-token">Admin API access token</Label>
            <Input
              id="shopify-token"
              type="password"
              placeholder="shpat_..."
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground -mt-2">
          El token sale de una custom app en el admin de Shopify (Settings →
          Apps → Develop apps) con scopes read_products, read_orders y
          read_customers. Recordá habilitar las tools{" "}
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
