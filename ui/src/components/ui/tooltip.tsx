import type { ComponentProps } from "react"
import { Tooltip as RadixTooltip } from "radix-ui"

import { cn } from "@/lib/utils"

export const Tooltip = RadixTooltip.Root
export const TooltipTrigger = RadixTooltip.Trigger

export function TooltipProvider(props: ComponentProps<typeof RadixTooltip.Provider>) {
  return <RadixTooltip.Provider delayDuration={300} {...props} />
}

export function TooltipContent({ children, className, sideOffset = 6, ...props }: ComponentProps<typeof RadixTooltip.Content>) {
  return (
    <RadixTooltip.Portal>
      <RadixTooltip.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn("z-50 max-w-xs break-words rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md", className)}
        {...props}
      >
        {children}
        <RadixTooltip.Arrow className="fill-popover" />
      </RadixTooltip.Content>
    </RadixTooltip.Portal>
  )
}
