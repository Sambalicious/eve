/** Pipeline page copy (v1.29.0, PROPOSAL until a copy deck says otherwise). */
export const pipelineCopy = {
  title: "Pipeline",
  description: "Every job you are working, by stage. Eve never sends anything from here.",
  markApplied: "Mark applied",
  applied: (role: string) => `${role} marked applied.`,
  undo: "Undo",
  moveTo: "Stage",
  remove: "Remove from pipeline",
  removed: (role: string) => `${role} removed from your pipeline.`,
  emptyBoard: {
    title: "Nothing in your pipeline yet",
    text: "Save a job from Jobs, or mark one applied, and it shows up here.",
  },
  emptyColumn: "Nothing here",
  loadError: "Couldn't load your pipeline. Try again.",
  retry: "Try again",
} as const
