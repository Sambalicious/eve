import { stackPostsCopy as c, type StackPost } from "@/entities/stack-post"

/** The row's visible title: the post's own, or "Untitled LinkedIn post/article" (C-SP-UNTITLED-*). */
export function postTitle(post: Pick<StackPost, "title" | "kind">): string {
  return post.title || c.untitled[post.kind]
}
