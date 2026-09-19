import { useAuth } from "@/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Zap, Shield, Wand2 } from "lucide-react";
import { TIERS } from "@/lib/tiers";

const COLORS = {
  neutral: "bg-neutral-800 text-neutral-400 border-neutral-700",
  blue:    "bg-blue-600/20 text-blue-300 border-blue-500/30",
  amber:   "bg-amber-600/20 text-amber-300 border-amber-500/30",
};

const ICONS = {
  neutral: Shield,
  blue:    Zap,
  amber:   Wand2,
};

export function TierBadge({ size = "sm" }: { size?: "sm" | "lg" }) {
  const { user } = useAuth();
  const tierKey = (user?.tier ?? "standard") as keyof typeof TIERS;
  const tier = TIERS[tierKey] ?? TIERS.standard;
  const colorClass = COLORS[tier.color];
  const Icon = ICONS[tier.color];

  if (size === "lg") {
    return (
      <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border ${colorClass}`}>
        <Icon className="w-3.5 h-3.5" />
        {tier.label}
      </div>
    );
  }

  return (
    <Badge variant="outline" className={`text-xs border ${colorClass}`}>
      {tier.short}
    </Badge>
  );
}
