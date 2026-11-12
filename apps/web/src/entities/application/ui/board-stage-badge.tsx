import { Badge } from "@/shared/ui/badge"
import { boardColumn } from "../model/board-column"
import { boardColumnCopy } from "../model/board-copy"
import type { Application } from "../model/application"

/** The Application's one board word as text (List view "Stage" column): the same mapping the board uses. */
export function BoardStageBadge({ app, advanced }: { app: Pick<Application, "state" | "failure" | "board">; advanced: boolean }) {
  return <Badge variant="outline">{boardColumnCopy[boardColumn(app, { advanced }).column]}</Badge>
}
