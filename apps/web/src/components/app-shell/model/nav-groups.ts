import {
  BriefcaseBusiness,
  CircleQuestionMark,
  Hand,
  KanbanSquare,
  LayoutDashboard,
  ListChecks,
  MessageSquareText,
  PauseCircle,
  Search,
  Settings,
  UserRoundCheck,
} from "lucide-react"

import { isAdvancedOn, type Viewer } from "@/entities/viewer"
import type { NavItem } from "../ui/nav-main"
import { navCopy, needsCopy } from "./nav-copy"

export interface NavGroup {
  /** No label: the six default items carry no heading (AC-3.2). */
  label: string | null
  items: NavItem[]
}

export type NeedsKind = "blocked" | "uncertain" | "sameCompany" | "sample"

/** Counts behind the Needs you strip; a missing count is zero. */
export type NeedsCounts = Readonly<Partial<Record<NeedsKind, number>>>

export interface NeedsYouRow {
  kind: NeedsKind
  count: number
  label: string
  linkLabel: string
  url: string
}

export interface NeedsYouEntry {
  total: number
  rows: NeedsYouRow[]
  /** The strip's own link when only one kind is waiting; null opens the list. */
  directUrl: string | null
}

export interface NavModel {
  needsYou: NeedsYouEntry | null
  groups: NavGroup[]
}

const NEEDS_URL: Record<NeedsKind, string> = {
  blocked: "/blocked",
  uncertain: "/uncertain",
  sameCompany: "/blocked",
  sample: "/activation",
}

const NEEDS_ORDER: readonly NeedsKind[] = ["blocked", "sameCompany", "uncertain", "sample"]

/** The Needs you strip: ignores the switch, but with Advanced on the group items carry the counts instead (AC-3.7). */
export function needsYouEntry(counts: NeedsCounts): NeedsYouEntry | null {
  const rows = NEEDS_ORDER.flatMap((kind): NeedsYouRow[] => {
    const count = counts[kind] ?? 0
    return count > 0
      ? [{ kind, count, label: needsCopy[kind].label(count), linkLabel: needsCopy[kind].link, url: NEEDS_URL[kind] }]
      : []
  })
  if (rows.length === 0) return null
  const urls = new Set(rows.map((row) => row.url))
  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    rows,
    directUrl: urls.size === 1 ? rows[0].url : null,
  }
}

function badge(n: number | undefined): string | null {
  return n ? String(n) : null
}

/**
 * The navigation for a viewer (R3): the six default items, then the Automatic applying
 * group only when Advanced is on. Pure, so every viewer and count combination is a table test.
 */
export function navModel(viewer: Viewer, counts: NeedsCounts, profileBadge: string | null): NavModel {
  const advanced = isAdvancedOn(viewer)
  const groups: NavGroup[] = [
    {
      label: null,
      items: [
        { title: navCopy.item.home, url: "/dashboard", icon: LayoutDashboard },
        { title: navCopy.item.jobs, url: "/postings", icon: BriefcaseBusiness },
        { title: navCopy.item.findJobs, url: "/find-jobs", icon: Search },
        { title: navCopy.item.applications, url: "/applications", icon: KanbanSquare },
        { title: navCopy.item.pipeline, url: "/pipeline", icon: KanbanSquare },
        { title: navCopy.item.profile, url: "/profile", icon: UserRoundCheck, badge: profileBadge },
        { title: navCopy.item.settings, url: "/settings", icon: Settings },
      ],
    },
  ]
  if (advanced) {
    groups.push({
      label: navCopy.groupAutomatic,
      items: [
        { title: navCopy.item.gate, url: "/activation", icon: ListChecks, badge: badge(counts.sample) },
        { title: navCopy.item.blocked, url: "/blocked", icon: Hand, badge: badge((counts.blocked ?? 0) + (counts.sameCompany ?? 0)) },
        { title: navCopy.item.uncertain, url: "/uncertain", icon: CircleQuestionMark, badge: badge(counts.uncertain) },
        { title: navCopy.item.formAnswers, url: "/answers", icon: MessageSquareText },
        { title: navCopy.item.pauseCost, url: "/pause-and-cost", icon: PauseCircle },
      ],
    })
  }
  return { needsYou: advanced ? null : needsYouEntry(counts), groups }
}
