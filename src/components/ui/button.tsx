import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { usePressable } from "@/hooks";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-[15px] leading-none font-semibold transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // Touch-target rule (PRD prd.md:815/827): any control reachable on a touch
      // device must be >= 44x44px at EVERY width, not only at lg:. `default`,
      // `lg` and `icon`/`icon-lg` all meet it on their own, so they are the safe
      // choices below lg.
      //
      // `sm` (h-9) and `icon-sm` (size-9) are BELOW the minimum by design — they
      // are compact variants for dense pointer-oriented chrome. They are not
      // banned, but any use that can render below 1024px must add its own
      // `min-h-11` (and `min-w-11` for short labels); see recipe-filter-bar.tsx
      // and list-options-controls.tsx.
      //
      // Enforced by src/test/touch-target-rule.test.ts (bans lg:-only sizing)
      // and e2e/touch-targets.spec.ts (measures real boxes at 390px and 900px).
      size: {
        default: "h-11 px-4 py-2 has-[>svg]:px-3",
        sm: "h-9 rounded-lg gap-1.5 px-3 text-sm has-[>svg]:px-2.5",
        lg: "h-11 rounded-xl px-6 text-base has-[>svg]:px-4",
        icon: "size-11",
        "icon-sm": "size-9",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  onPointerDown,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";
  const pressable = usePressable();

  return (
    <Comp
      data-slot="button"
      className={cn(
        buttonVariants({ variant, size }),
        pressable.className,
        className,
      )}
      onPointerDown={(event) => {
        pressable.onPointerDown(event);
        onPointerDown?.(event);
      }}
      {...props}
    />
  );
}

export { Button, buttonVariants };
