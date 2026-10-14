import * as React from "react"
import { cn } from "@/lib/utils"
import { Tabs as TabsPrimitive } from "radix-ui"

// The section navigation of the full page: a horizontal, scrolling row on narrow pages and a vertical list on wide ones
// (Radix supplies the tab/tabpanel roles and the arrow keys of the orientation).
function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn("group/tabs flex gap-4 data-[orientation=horizontal]:flex-col", className)}
      {...props}
    />
  )
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "flex text-muted-foreground group-data-[orientation=horizontal]/tabs:gap-1 group-data-[orientation=horizontal]/tabs:overflow-x-auto group-data-[orientation=vertical]/tabs:flex-col group-data-[orientation=vertical]/tabs:gap-0.5",
        className
      )}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-9 shrink-0 items-center gap-2.5 rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "data-[state=active]:bg-selected data-[state=active]:text-foreground data-[state=active]:[&_svg]:text-ring",
        // the selected item carries a non-colour cue too: a bar at its leading edge (vertical) or under it (horizontal)
        "after:absolute after:rounded-full after:bg-ring after:opacity-0 data-[state=active]:after:opacity-100 group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start group-data-[orientation=vertical]/tabs:after:inset-y-2 group-data-[orientation=vertical]/tabs:after:left-0 group-data-[orientation=vertical]/tabs:after:w-[3px] group-data-[orientation=horizontal]/tabs:after:inset-x-3 group-data-[orientation=horizontal]/tabs:after:bottom-0 group-data-[orientation=horizontal]/tabs:after:h-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("min-w-0 outline-none", className)} {...props} />
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
