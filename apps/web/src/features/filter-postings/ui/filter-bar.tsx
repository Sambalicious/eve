import { useRef, useState, type KeyboardEvent, type RefObject } from "react"
import { ChevronDown, Search, X } from "lucide-react"

import {
  formatCopy,
  postingsCopy,
  ROLE_FAMILIES,
  type PostingFilter,
  type RoleFamily,
} from "@/entities/job-posting"
import { POSTING_KEYWORD_MAX_LENGTH } from "@eve/contracts"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { Checkbox } from "@/shared/ui/checkbox"
import { Popover, PopoverClose, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/shared/ui/popover"
import { Separator } from "@/shared/ui/separator"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/shared/ui/input-group"
import { useTitleSearch } from "../model/use-title-search"

/**
 * The Job Postings filter bar (design addendum F4-8a, F4-8b): a title search
 * and the "Role family" menu, plus "Clear filters" while a filter is on.
 * Each change calls `onChange` with the whole new filter.
 */
export function FilterBar({
  filter,
  families,
  onChange,
  showClear,
  searchRef,
}: {
  filter: PostingFilter
  /** v1.18.0 (AC-3.7, P7): the families the panel lists, the Candidate's targets in catalog order. */
  families: readonly RoleFamily[]
  onChange: (filter: PostingFilter) => void
  /** False while the filter empty state shows its own "Clear filters". */
  showClear: boolean
  /** The page focuses the search field after the empty state's "Clear filters". */
  searchRef?: RefObject<HTMLInputElement | null>
}) {
  const ownRef = useRef<HTMLInputElement>(null)
  const inputRef = searchRef ?? ownRef
  const isActive = filter.families.length > 0 || filter.keyword !== null
  const search = useTitleSearch({
    keyword: filter.keyword,
    isFilterActive: isActive,
    onCommit: (keyword) => onChange({ ...filter, keyword }),
  })

  return (
    <div
      role="search"
      aria-label={postingsCopy.filterBar.landmark}
      className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center"
    >
      <InputGroup className="w-full pointer-coarse:h-11 sm:w-64 lg:w-72">
        <label htmlFor="postings-title-search" className="sr-only">
          {postingsCopy.search.label}
        </label>
        <InputGroupInput
          id="postings-title-search"
          ref={inputRef}
          type="search"
          placeholder={postingsCopy.search.placeholder}
          maxLength={POSTING_KEYWORD_MAX_LENGTH}
          autoComplete="off"
          enterKeyHint="search"
          value={search.text}
          onChange={search.onChange}
          onKeyDown={search.onKeyDown}
          className="[&::-webkit-search-cancel-button]:appearance-none"
        />
        <InputGroupAddon>
          <Search aria-hidden="true" />
        </InputGroupAddon>
        {search.text !== "" && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              aria-label={postingsCopy.search.clear}
              className="pointer-coarse:size-10"
              onClick={() => {
                search.clear()
                inputRef.current?.focus()
              }}
            >
              <X aria-hidden="true" />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
      <div className="flex items-center gap-2">
        <FamilyPanel
          families={families}
          selected={filter.families}
          onChange={(families) => onChange({ ...filter, families })}
        />
        {showClear && isActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              // Drop a keystroke still waiting for the debounce, or it would bring the keyword back (F-QA8-02).
              search.reset()
              onChange({ families: [], keyword: null })
              // The button goes away with the filter; focus moves to the search field (design addendum).
              inputRef.current?.focus()
            }}
          >
            {postingsCopy.clearFilters.button}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * The Role family panel (design r2 B2, Candidate decision D13): a non-modal
 * popover with the title "Role family" and Close on one header line, a divider,
 * then one checkbox per target family (EPIC-0006 P7) in a fieldset. A non-target
 * family named in the URL stays in the filter (the API answers it with an empty
 * page) and is dropped by "Show all role families". Each check applies at once and
 * the panel stays open. Escape, Close, Shift+Tab from Close (8d.22) and "Show all
 * role families" return focus to the button; an outside click leaves focus where it landed.
 */
function FamilyPanel({
  families,
  selected,
  onChange,
}: {
  families: readonly RoleFamily[]
  selected: readonly RoleFamily[]
  onChange: (families: RoleFamily[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [side, setSide] = useState<"bottom" | "top">("bottom")
  const triggerRef = useRef<HTMLButtonElement>(null)
  const firstCheckbox = useRef<HTMLButtonElement>(null)

  function onOpenChange(next: boolean) {
    // Design r2 B2: below the button unless under 240px fits there. The panel then
    // shrinks to the space on its side and only the checkbox group scrolls.
    if (next && triggerRef.current) {
      const below = window.innerHeight - triggerRef.current.getBoundingClientRect().bottom - EDGE_PX
      setSide(below >= MIN_SPACE_BELOW_PX ? "bottom" : "top")
    }
    setOpen(next)
  }
  const { familyMenu } = postingsCopy

  // Design r3: Shift+Tab from Close closes the panel on that same press and focuses the
  // button, as Escape does. Without this the first press lands on the button with the
  // panel still open (the portal sits after it), and only a second press closes it.
  function onCloseKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "Tab" || !event.shiftKey) return
    event.preventDefault()
    setOpen(false)
    triggerRef.current?.focus()
  }

  const toggle = (family: RoleFamily, checked: boolean) => {
    const next = new Set(selected)
    if (checked) next.add(family)
    else next.delete(family)
    onChange(ROLE_FAMILIES.filter((f) => next.has(f)))
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger ref={triggerRef} render={<Button variant="outline" size="lg" />}>
        {familyMenu.trigger}
        {selected.length > 0 && (
          <>
            {/*
              Name computation trims each element's text, so the spaces around the badge are
              separate text nodes: the name reads "Role family 2 selected" (WEB-04). The flex
              layout doesn't render them.
            */}{" "}
            <Badge variant="secondary" className="shrink-0 tabular-nums">
              {formatCopy(familyMenu.badgeCount, { count: selected.length })}
            </Badge>{" "}
            <span className="sr-only">{familyMenu.triggerSelected}</span>
          </>
        )}
        <ChevronDown aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align="start"
        // The side is chosen on open (above); never cover the sticky shell header.
        collisionPadding={{ top: HEADER_HEIGHT_PX, right: EDGE_PX, bottom: EDGE_PX, left: EDGE_PX }}
        collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
        initialFocus={firstCheckbox}
        className="max-h-[min(var(--available-height),30rem)] w-72 max-w-[calc(100vw-32px)] gap-0 p-0"
      >
        <PopoverHeader className="flex-row items-center justify-between gap-2 py-1.5 ps-3 pe-1.5">
          <PopoverTitle render={<h2 />} className="text-[0.9375rem] leading-[1.4] font-semibold">
            {familyMenu.title}
          </PopoverTitle>
          <PopoverClose
            render={<Button variant="ghost" size="icon-sm" className="pointer-coarse:size-10" />}
            aria-label={familyMenu.close}
            onKeyDown={onCloseKeyDown}
          >
            <X aria-hidden="true" />
          </PopoverClose>
        </PopoverHeader>
        <Separator />
        {/* Scrolling sits on a plain div: a scrolling <fieldset> doesn't clip its rows in Chromium. */}
        <div data-slot="family-panel-scroll" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <fieldset className="m-0 min-w-0 border-0 p-1.5">
            <legend className="float-left w-full px-1.5 pt-1 pb-1.5 text-[0.78125rem] text-muted-foreground">
              {familyMenu.groupLabel}
            </legend>
            {families.map((family, index) => (
              <label
                key={family}
                className="flex min-h-8 cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-muted pointer-coarse:min-h-11 pointer-coarse:items-center"
              >
                <Checkbox
                  ref={index === 0 ? firstCheckbox : undefined}
                  checked={selected.includes(family)}
                  onCheckedChange={(checked) => toggle(family, checked)}
                  className="mt-0.5 pointer-coarse:mt-0"
                />
                <span className="min-w-0 [overflow-wrap:anywhere]">{postingsCopy.family[family]}</span>
              </label>
            ))}
          </fieldset>
        </div>
        {selected.length > 0 && (
          <>
            <Separator />
            <div className="p-1.5">
              <Button
                variant="ghost"
                className="w-full justify-start pointer-coarse:h-11"
                onClick={() => {
                  onChange([])
                  setOpen(false)
                }}
              >
                {familyMenu.showAll}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** The sticky shell header, `--header-height` (3.5rem). */
const HEADER_HEIGHT_PX = 56
/** Collision padding at the other edges. */
const EDGE_PX = 16
/** Header plus three rows (design r2 B2): less than this below the button flips the panel above it. */
const MIN_SPACE_BELOW_PX = 240
