import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, Shield } from "lucide-react";

/**
 * Status badge for marketplace listings (spec 0.4/0.6):
 * - `published` → "Certified" (buyable)
 * - `certifying` → "Certifying" (visible, NOT buyable)
 * Renders nothing for any other status.
 */
export function ListingStatusBadge({ status }: { status: string | null }) {
  const { t } = useTranslation("pages");

  if (status === "certifying") {
    return (
      <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-xs">
        <Shield className="w-3 h-3 mr-1" />
        {t("pages:marketplace.badges.certifying")}
      </Badge>
    );
  }

  if (status === "published") {
    return (
      <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">
        <ShieldCheck className="w-3 h-3 mr-1" />
        {t("pages:marketplace.badges.certified")}
      </Badge>
    );
  }

  return null;
}
