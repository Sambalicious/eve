import { render } from "@testing-library/react"
import { useRef } from "react"
import { describe, expect, it } from "vitest"

import { useOverflowEnd } from "./use-overflow-end"

function Strip({ scrollWidth, clientWidth }: { scrollWidth: number; clientWidth: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useOverflowEnd(ref)
  return (
    <div
      data-testid="strip"
      ref={(el) => {
        if (el) {
          Object.defineProperty(el, "scrollWidth", { value: scrollWidth, configurable: true })
          Object.defineProperty(el, "clientWidth", { value: clientWidth, configurable: true })
        }
        ref.current = el
      }}
    />
  )
}

describe("useOverflowEnd (DP-B1-07)", () => {
  it("marks the element while content remains past the end", () => {
    const { getByTestId } = render(<Strip scrollWidth={360} clientWidth={343} />)
    expect(getByTestId("strip")).toHaveAttribute("data-overflow-end")
  })

  it("leaves it unmarked when everything fits", () => {
    const { getByTestId } = render(<Strip scrollWidth={343} clientWidth={343} />)
    expect(getByTestId("strip")).not.toHaveAttribute("data-overflow-end")
  })
})
