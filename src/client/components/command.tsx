import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { cn } from "./popover";

/**
 * shadcn's Command (cmdk), restyled onto this app's tokens.
 *
 * Only the parts in use are vendored — Input, List, Empty, Group, Item. Dialog,
 * Separator and Shortcut are shadcn's other pieces; add them when something
 * needs one rather than carrying dead components.
 */
export const Command = ({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) => (
  <CommandPrimitive className={cn("flex w-full flex-col overflow-hidden bg-surface", className)} {...props} />
);

export function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-2.5">
      <Search className="size-3.5 shrink-0 text-faint" aria-hidden />
      <CommandPrimitive.Input
        className={cn(
          "h-9 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-faint disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

export const CommandList = ({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) => (
  <CommandPrimitive.List className={cn("max-h-60 overflow-y-auto overflow-x-hidden p-1.5", className)} {...props} />
);

export const CommandEmpty = (props: React.ComponentProps<typeof CommandPrimitive.Empty>) => (
  <CommandPrimitive.Empty className="py-5 text-center text-[0.8125rem] text-muted" {...props} />
);

export const CommandGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) => (
  <CommandPrimitive.Group
    className={cn(
      "text-foreground [&_[cmdk-group-heading]]:px-1 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[0.6875rem] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint",
      className,
    )}
    {...props}
  />
);

export const CommandItem = ({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) => (
  <CommandPrimitive.Item
    className={cn(
      "cursor-pointer select-none rounded-sm outline-none data-[selected=true]:bg-sunken",
      className,
    )}
    {...props}
  />
);
