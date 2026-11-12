import { LogOut } from "lucide-react"

import { DropdownMenuItem } from "@/shared/ui/dropdown-menu"

/** "Sign out" entry for the account menu. It only asks; `SignOutDialog` confirms. */
export function SignOutMenuItem({ onSelect }: { onSelect: () => void }) {
  return (
    <DropdownMenuItem className="cursor-pointer" onClick={onSelect}>
      <LogOut aria-hidden="true" />
      Sign out
    </DropdownMenuItem>
  )
}
