import { useId, useRef, useState, type DragEvent } from "react"
import { Lock, Upload } from "lucide-react"

import { careerProfileCopy, ResumeProblemAlert, type ResumeProblem } from "@/entities/career-profile"
import { cn } from "@/shared/lib/utils"
import { Button } from "@/shared/ui/button"
import { ButtonLink } from "@/shared/ui/button-link"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { RESUME_ACCEPT } from "../model/resume-file"
import { useUploadResume } from "../model/use-upload-resume"

interface ResumeDropZoneProps {
  /** False until Anthropic is approved: the zone is unavailable and shows C-PROFILE-1. */
  isAiProviderApproved: boolean
  /** The last drafting attempt's failure, shown until the next upload replaces it. */
  draftingFailure?: ResumeProblem | null
  /** Upload screen: replaces the button and helper text, and keeps the drop target in place, disabled, until approval. */
  welcome?: { prompt: string; choose: string; helper: string }
}

/**
 * Drop or pick a PDF or DOCX resume. Disabled with C-PROFILE-1 until Anthropic
 * is approved, so nothing can be sent before then. Refusals and drafting
 * failures stay inline; the button's retry label comes from the problem shown
 * (C-PROFILE-UP-1).
 */
export function ResumeDropZone({ isAiProviderApproved, draftingFailure = null, welcome }: ResumeDropZoneProps) {
  const inputId = useId()
  const errorId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const { upload, isUploading, refusal } = useUploadResume()
  const isAvailable = isAiProviderApproved && !isUploading
  const problem = refusal ?? (isUploading ? null : draftingFailure)

  const pick = (files: FileList | null) => {
    const file = files?.[0]
    if (file) upload(file)
    if (inputRef.current) inputRef.current.value = ""
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragOver(false)
    if (isAvailable) pick(event.dataTransfer.files)
  }

  if (!isAiProviderApproved && !welcome) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl bg-muted/50 p-5 text-sm">
        <p className="flex items-center gap-2 font-medium">
          <Lock aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          {careerProfileCopy.uploadDisabled}
        </p>
        <ButtonLink variant="outline" size="sm" to="/privacy#ai-provider">
          {careerProfileCopy.reviewAndApprove}
        </ButtonLink>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        onDragOver={(event) => {
          event.preventDefault()
          setIsDragOver(true)
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-10 text-center text-sm transition-colors duration-150",
          isDragOver
            ? "border-foreground/40 bg-muted/60"
            : "border-input hover:bg-muted/30"
        )}
      >
        <span
          aria-hidden="true"
          className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
        >
          <Upload className="size-5" />
        </span>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={RESUME_ACCEPT}
          className="sr-only"
          disabled={!isAvailable}
          aria-describedby={problem ? errorId : undefined}
          aria-invalid={refusal ? true : undefined}
          onChange={(event) => pick(event.target.files)}
        />
        <Button
          variant="outline"
          aria-busy={isUploading}
          disabled={!isAvailable}
          onClick={() => inputRef.current?.click()}
        >
          {isUploading && <ButtonSpinner />}
          {isUploading ? careerProfileCopy.uploading : (problem?.retryLabel ?? welcome?.choose ?? careerProfileCopy.chooseResume)}
        </Button>
        <label
          htmlFor={inputId}
          className="max-w-sm text-[0.8125rem] text-muted-foreground"
        >
          {welcome ? `${welcome.prompt}. ${welcome.helper}` : careerProfileCopy.dropZoneText}
        </label>
      </div>
      {problem && <ResumeProblemAlert id={errorId} problem={problem} />}
    </div>
  )
}
