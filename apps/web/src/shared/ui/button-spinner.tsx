import { LoaderCircle } from "lucide-react"

/** 16px spinner shown before a button's progressive label. Static under reduced motion. */
export function ButtonSpinner() {
  return <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
}
