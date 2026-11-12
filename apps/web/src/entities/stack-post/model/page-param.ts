import { STACK_POSTS_PAGE_PATTERN } from "@eve/contracts"

/**
 * `?page=` as the page requests it (design-spec F6 step 4, worst-case table):
 * anything that is not a valid page number (`abc`, `-1`, `0`, `01`, `1.5`) is
 * page 1. A page past the last is corrected once the totals arrive.
 */
export function readPageParam(value: string | null): number {
  return value !== null && STACK_POSTS_PAGE_PATTERN.test(value) ? Number(value) : 1
}
