import { useId, useReducer, useRef } from "react"
import { Plus, X } from "lucide-react"

import {
  careerProfileCopy,
  type ProfileSection,
} from "@/entities/career-profile"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { Textarea } from "@/shared/ui/textarea"
import {
  draftEditorReducer,
  startEditing,
  toDraftContent,
  type EditableSection,
} from "../model/draft-editor"
import { useSaveDraft } from "../model/use-edit-career-profile"

interface CareerProfileEditorProps {
  /** The draft's sections when one exists, else the version in use. */
  sections: readonly ProfileSection[]
  onClose: () => void
}

/**
 * Edit mode (F1 step 3a): every fact is an editable row, with "Add fact" per
 * role and "Remove" per fact. "Save draft" creates or updates the one draft
 * version; the approved version is never changed. Editing sends nothing to an
 * AI provider, so it works before Anthropic is approved.
 */
export function CareerProfileEditor({
  sections,
  onClose,
}: CareerProfileEditorProps) {
  const [state, dispatch] = useReducer(
    draftEditorReducer,
    sections,
    startEditing
  )
  const { save, isSaving } = useSaveDraft({ onSaved: onClose })
  const nextKey = useRef(0)

  return (
    <form
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        save(toDraftContent(state))
      }}
    >
      {state.map((entry) => (
        <SectionEditor
          key={entry.section.id}
          entry={entry}
          disabled={isSaving}
          onEdit={(key, text) =>
            dispatch({ type: "edit", sectionId: entry.section.id, key, text })
          }
          onRemove={(key) =>
            dispatch({ type: "remove", sectionId: entry.section.id, key })
          }
          onAdd={() =>
            dispatch({
              type: "add",
              sectionId: entry.section.id,
              key: `new-${nextKey.current++}`,
            })
          }
        />
      ))}
      <div className="profile-save-bar flex flex-wrap gap-2 border-t pt-4 md:sticky md:bottom-0 md:bg-background/90 md:backdrop-blur-sm">
        <Button type="submit" aria-busy={isSaving} disabled={isSaving}>
          {isSaving && <ButtonSpinner />}
          {isSaving ? "Saving…" : careerProfileCopy.saveDraft}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={isSaving}
          onClick={onClose}
        >
          {careerProfileCopy.cancel}
        </Button>
      </div>
    </form>
  )
}

interface SectionEditorProps {
  entry: EditableSection
  disabled: boolean
  onEdit: (key: string, text: string) => void
  onRemove: (key: string) => void
  onAdd: () => void
}

function SectionEditor({
  entry,
  disabled,
  onEdit,
  onRemove,
  onAdd,
}: SectionEditorProps) {
  const headingId = useId()
  const { section, facts } = entry
  const role = section.organization
    ? `${section.title} at ${section.organization}`
    : section.title
  const meta = [section.organization, section.period]
    .filter(Boolean)
    .join(" · ")

  return (
    <fieldset
      aria-labelledby={headingId}
      className="grid min-w-0 gap-4 border-t py-6 first:border-t-0 first:pt-2 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] md:gap-10"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3
          id={headingId}
          className="text-[0.9375rem] font-semibold tracking-[-0.01em] [overflow-wrap:anywhere]"
        >
          {section.title}
        </h3>
        {meta && (
          <p className="text-[0.8125rem] text-muted-foreground [overflow-wrap:anywhere]">
            {meta}
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <ol className="flex flex-col gap-3">
          {facts.map((fact, index) => {
            const k = index + 1
            return (
              <li key={fact.key} className="flex items-start gap-2">
                <Textarea
                  aria-label={`${role}, fact ${k}`}
                  value={fact.text}
                  maxLength={1000}
                  rows={2}
                  disabled={disabled}
                  className="min-h-16 flex-1"
                  onChange={(event) => onEdit(fact.key, event.target.value)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  disabled={disabled}
                  aria-label={`Remove fact ${k} from ${section.title}`}
                  onClick={() => onRemove(fact.key)}
                >
                  <X aria-hidden="true" />
                  <span aria-hidden="true">{careerProfileCopy.remove}</span>
                </Button>
              </li>
            )
          })}
        </ol>
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2"
            disabled={disabled}
            onClick={onAdd}
          >
            <Plus aria-hidden="true" />
            {careerProfileCopy.addFact}
          </Button>
        </div>
      </div>
    </fieldset>
  )
}
