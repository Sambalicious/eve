import { SkeletonBadge, SkeletonButton, SkeletonInput, SkeletonSection, SkeletonText } from "@/shared/ui/skeleton"

/** Search links body: two group rows (design-spec inventory, StackPostsSkeleton). */
export function SearchLinksBodySkeleton() {
  return (
    <ul className="flex flex-col divide-y border-y" aria-hidden="true">
      {[0, 1].map((i) => (
        <li key={i} className="flex flex-col gap-2 py-3 md:grid md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] md:gap-x-6">
          <SkeletonText className="text-sm" widths={i ? ["w-32"] : ["w-64 max-w-full", "w-40"]} />
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <SkeletonButton size="sm" className="w-32" />
              <SkeletonButton size="sm" className="w-28" />
              <SkeletonButton size="sm" className="w-32" />
            </div>
            <SkeletonText className="text-sm" widths={["w-40"]} />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Alert feeds body: the verification row, one feed row and the form. */
export function AlertFeedsBodySkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <div className="flex flex-col gap-1.5">
        <SkeletonText className="text-sm" widths={["w-36"]} />
        <SkeletonBadge />
        <SkeletonText className="text-sm" widths={["w-80 max-w-full"]} />
      </div>
      <div className="flex flex-col gap-2 border-t pt-4">
        <SkeletonText className="text-sm" widths={["w-20"]} />
        <div className="flex items-start justify-between gap-4 border-y py-3">
          <div className="flex flex-1 flex-col gap-1">
            <SkeletonText className="text-sm" widths={["w-40"]} />
            <SkeletonText className="text-[0.8125rem]" widths={["w-56 max-w-full"]} />
          </div>
          <SkeletonButton size="sm" className="w-20" />
        </div>
        <div className="flex flex-col gap-1.5 pt-2">
          <SkeletonText className="text-sm" widths={["w-16"]} />
          <SkeletonInput />
        </div>
      </div>
    </div>
  )
}

/** Posts body: five rows. */
export function PostsBodySkeleton() {
  return (
    <ol className="flex flex-col divide-y border-y" aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <li key={i} className="flex flex-col gap-1 py-3">
          <SkeletonText className="text-sm" widths={[i % 2 ? "w-72 max-w-full" : "w-96 max-w-full"]} />
          <SkeletonText className="text-[0.8125rem]" widths={["w-full", "w-2/3"]} />
          <SkeletonText className="text-[0.78125rem]" widths={["w-64 max-w-full"]} />
        </li>
      ))}
    </ol>
  )
}

/** The whole Stack posts page on first load: three sections with their bodies. */
export function StackPostsSkeleton() {
  return (
    <div className="flex flex-col gap-7" aria-hidden="true">
      <SkeletonSection titleWidth="w-28" descriptionWidths={["w-full", "w-1/2"]}>
        <SearchLinksBodySkeleton />
      </SkeletonSection>
      <SkeletonSection titleWidth="w-24" descriptionWidths={["w-full"]}>
        <AlertFeedsBodySkeleton />
      </SkeletonSection>
      <SkeletonSection titleWidth="w-12">
        <PostsBodySkeleton />
      </SkeletonSection>
    </div>
  )
}
