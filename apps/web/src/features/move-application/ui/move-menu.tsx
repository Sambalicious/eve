import { Ellipsis } from "lucide-react"

import { boardUiCopy } from "@/entities/application"
import { Button } from "@/shared/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuGroup, DropdownMenuTrigger } from "@/shared/ui/dropdown-menu"
import type { MoveOption } from "../model/move-action"

/**
 * A card's "Move to…" menu (AC-6.6): a keyboard-accessible dropdown. Enter or Space opens it, arrows move, Esc
 * closes and returns focus to the button. Targets the card can't go to show disabled with the reason beside
 * them, so no tooltip carries the explanation.
 */
export function MoveMenu({
  title,
  options,
  busy,
  onPick,
}: {
  title: string
  options: readonly MoveOption[]
  busy: boolean
  onPick: (option: MoveOption) => void
}) {
  if (options.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={boardUiCopy.cardMoveAria(title)}
            aria-busy={busy || undefined}
            disabled={busy}
            className="-mr-1 shrink-0 pointer-coarse:size-11"
          />
        }
      >
        <Ellipsis aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{boardUiCopy.menuLabel}</DropdownMenuLabel>
          {options.map((option) => {
            const refused = option.action.kind === "refused"
            return (
              <DropdownMenuItem
                key={option.target}
                disabled={refused}
                className="pointer-coarse:min-h-11"
                onClick={() => !refused && onPick(option)}
              >
                <span className="flex min-w-0 flex-col">
                  <span>{option.label}</span>
                  {option.action.kind === "refused" && (
                    <span className="text-xs whitespace-normal text-muted-foreground">{option.action.reason}</span>
                  )}
                </span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
