import { cn } from "@/lib/utils"

export const APP_NAME = "dubvibe_mini"

export function BrandMark({
  wordmark = false,
  className,
}: {
  wordmark?: boolean
  className?: string
}) {
  return (
    <span className={cn("inline-flex h-10 items-center gap-2", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/dubvibe-logo.png" alt="" aria-hidden="true" className="h-full w-auto" />
      {wordmark && <span className="text-[0.9em] font-semibold tracking-tight text-foreground">{APP_NAME}</span>}
    </span>
  )
}
