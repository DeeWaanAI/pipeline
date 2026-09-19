import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { AppShell } from "@/components/layout/AppShell";
import { ListingStatusBadge } from "@/components/marketplace/ListingStatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Store,
  Search,
  Filter,
  Star,
  Loader2,
  Tag,
} from "lucide-react";

export default function MarketplaceBrowse() {
  const { t } = useTranslation("pages");
  const [category, setCategory] = useState("all");
  const [sortBy, setSortBy] = useState<"newest" | "price_asc" | "price_desc" | "grade" | "popular">("newest");
  const [searchQuery, setSearchQuery] = useState("");

  const CATEGORIES = [
    { value: "all", label: t("pages:marketplace.browse.categories.all") },
    { value: "translation", label: t("pages:marketplace.browse.categories.translation") },
    { value: "writing", label: t("pages:marketplace.browse.categories.writing") },
    { value: "code", label: t("pages:marketplace.browse.categories.code") },
    { value: "analysis", label: t("pages:marketplace.browse.categories.analysis") },
    { value: "creative", label: t("pages:marketplace.browse.categories.creative") },
    { value: "other", label: t("pages:marketplace.browse.categories.other") },
  ];

  const { data: listings, isLoading } = trpc.marketplace.list.useQuery({
    category: category === "all" ? undefined : category,
    sortBy,
    status: "published",
  });

  const filteredListings = listings?.filter((l) =>
    !searchQuery ||
    l.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    l.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <AppShell>
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* Header */}
      <div className="border-b border-neutral-800 bg-neutral-900/50">
        <div className="max-w-7xl mx-auto px-6 py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Store className="w-7 h-7 text-blue-400" />
              <div>
                <h1 className="text-2xl font-bold text-neutral-100">{t("pages:marketplace.browse.title")}</h1>
                <p className="text-sm text-neutral-400">{t("pages:marketplace.browse.subtitle")}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Link to="/creator/listings">
                <Button variant="outline" size="sm" className="border-neutral-700 text-neutral-300 hover:text-white">
                  <Tag className="w-4 h-4 mr-1.5" />
                  {t("pages:marketplace.browse.sellPipeline")}
                </Button>
              </Link>
              <Link to="/reviewer/portal">
                <Button variant="outline" size="sm" className="border-neutral-700 text-neutral-300 hover:text-white">
                  <Star className="w-4 h-4 mr-1.5" />
                  {t("pages:marketplace.browse.review")}
                </Button>
              </Link>
            </div>
          </div>

          {/* Filters */}
          <div className="flex items-center gap-3 mt-5">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
              <Input
                placeholder={t("pages:marketplace.browse.searchPlaceholder")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 bg-neutral-900 border-neutral-700 text-neutral-100 placeholder:text-neutral-500"
              />
            </div>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-44 bg-neutral-900 border-neutral-700 text-neutral-100">
                <Filter className="w-4 h-4 mr-1.5 text-neutral-500" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-neutral-900 border-neutral-700">
                {CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value} className="text-neutral-100">
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
              <SelectTrigger className="w-40 bg-neutral-900 border-neutral-700 text-neutral-100">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-neutral-900 border-neutral-700">
                <SelectItem value="newest" className="text-neutral-100">{t("pages:marketplace.browse.sort.newest")}</SelectItem>
                <SelectItem value="popular" className="text-neutral-100">{t("pages:marketplace.browse.sort.popular")}</SelectItem>
                <SelectItem value="grade" className="text-neutral-100">{t("pages:marketplace.browse.sort.grade")}</SelectItem>
                <SelectItem value="price_asc" className="text-neutral-100">{t("pages:marketplace.browse.sort.priceAsc")}</SelectItem>
                <SelectItem value="price_desc" className="text-neutral-100">{t("pages:marketplace.browse.sort.priceDesc")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Listings Grid */}
      <div className="max-w-7xl mx-auto px-6 py-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
          </div>
        ) : !filteredListings?.length ? (
          <div className="text-center py-20">
            <Store className="w-12 h-12 text-neutral-600 mx-auto mb-3" />
            <h3 className="text-lg font-medium text-neutral-300">{t("pages:marketplace.browse.noPipelines")}</h3>
            <p className="text-sm text-neutral-500 mt-1">{t("pages:marketplace.browse.noPipelinesDesc")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredListings.map((listing) => (
              <Link
                key={listing.id}
                to={`/marketplace/${listing.id}`}
                className="group block bg-neutral-900 border border-neutral-800 rounded-lg p-5 hover:border-blue-500/40 transition-all"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="text-xs border-neutral-700 text-neutral-400 capitalize">
                      {listing.category}
                    </Badge>
                    <ListingStatusBadge status={listing.status} />
                  </div>
                  {listing.grade && (
                    <div className="flex items-center gap-1 text-amber-400">
                      <Star className="w-3.5 h-3.5 fill-amber-400" />
                      <span className="text-sm font-medium">{listing.grade}</span>
                    </div>
                  )}
                </div>

                <h3 className="text-lg font-semibold text-neutral-100 group-hover:text-blue-400 transition-colors mb-1">
                  {listing.title}
                </h3>
                <p className="text-sm text-neutral-400 line-clamp-2 mb-4">
                  {listing.description || t("pages:marketplace.browse.noDescription")}
                </p>

                <div className="flex items-center justify-between pt-3 border-t border-neutral-800">
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-bold text-neutral-100">${listing.price}</span>
                    {listing.isSubscription && (
                      <span className="text-xs text-neutral-500">{t("pages:marketplace.browse.perMonth")}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-neutral-500">
                    <span>{listing.salesCount} {t("pages:marketplace.browse.sales")}</span>
                    {listing.reviewCount ? (
                      <span>{listing.reviewCount} {t("pages:marketplace.browse.reviews")}</span>
                    ) : null}
                    {listing.kappaScore && (
                      <span className="text-emerald-400">K={listing.kappaScore}</span>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
    </AppShell>
  );
}
