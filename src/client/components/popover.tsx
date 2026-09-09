import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * shadcn's Popover, restyled onto this app's tokens.
 *
 * Kept as the shadcn composition rather than a hand-rolled dropdown because the
 * parts that are easy to get subtly wrong — focus return, Escape, outside
 * click, and portalling out of any scrolling ancestor — come with it. The stock
 * shadcn palette (`bg-popover`, `text-popover-foreground`) is not this app's
 * vocabulary, so the classes below are repointed at `surface`/`border`/
 * `foreground`, which is what DESIGN.md means by restyling via tokens.
 */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 rounded-md bg-surface text-foreground shadow-float outline-none",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
