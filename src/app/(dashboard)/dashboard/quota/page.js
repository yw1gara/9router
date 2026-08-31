import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import ProviderLimits from "../usage/components/ProviderLimits";
import QuotaOverview from "./QuotaOverview";

export default function QuotaPage() {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* Expert layer: cross-account quota health monitor */}
      <Suspense fallback={<CardSkeleton />}>
        <QuotaOverview />
      </Suspense>

      {/* Existing per-provider quota details */}
      <Suspense fallback={<CardSkeleton />}>
        <ProviderLimits />
      </Suspense>
    </div>
  );
}
