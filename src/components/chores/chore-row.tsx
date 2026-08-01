import { Archive, Check, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { haptics } from "@/lib/haptics";
import type { ChoreBoardItem, ChoreCadence, ChoreScope } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ChoreRowProps {
  chore: ChoreBoardItem;
  /** Active scope tab. When it already implies the chore's cadence the label is
   * redundant (e.g. "Daily" inside the Today column) and is suppressed. */
  activeScope?: ChoreScope;
  onArchive?: () => void;
  onComplete?: () => void;
  onUncomplete?: () => void;
}

function cadenceLabel(cadence: ChoreBoardItem["cadence"]): string {
  if (cadence === "DAILY") return "Daily";
  if (cadence === "WEEKLY") return "Weekly";
  return "Monthly";
}

const IMPLIED_BY: Record<ChoreCadence, ChoreScope> = {
  DAILY: "TODAY",
  WEEKLY: "THIS_WEEK",
  MONTHLY: "THIS_MONTH",
};

export function ChoreRow({
  chore,
  activeScope,
  onArchive,
  onComplete,
  onUncomplete,
}: ChoreRowProps) {
  const showCadence = IMPLIED_BY[chore.cadence] !== activeScope;

  // Shared by the checkoff and the row-body button below, so both stay on the
  // same haptics path (success() on the completing transition only).
  const toggleCompletion = () => {
    if (chore.completed) {
      onUncomplete?.();
    } else {
      haptics.success();
      onComplete?.();
    }
  };

  return (
    <div
      data-testid={`chore-row-${chore.templateId}`}
      className={cn(
        "flex min-h-14 items-center gap-3 rounded-lg border p-3 transition-colors",
        chore.completed
          ? "border-border bg-muted/40"
          : "border-transparent bg-card hover:border-border",
      )}
    >
      {/*
        Keep this a raw <button>, not <Button>/usePressable (the Archive control
        beside it uses <Button>): a pressable would fire haptics.tap() on
        pointerdown, and the shared 40ms throttle would then coalesce away the
        haptics.success() pulse on click. The single completion pulse depends on
        no preceding tap. Guarded by the throttle-coupling test in haptics.test.ts.
      */}
      <button
        type="button"
        aria-label={
          chore.completed
            ? `Mark ${chore.title} incomplete`
            : `Mark ${chore.title} complete`
        }
        onClick={toggleCompletion}
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
          chore.completed
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background text-muted-foreground hover:border-primary hover:text-primary",
        )}
      >
        {chore.completed ? (
          <Check className="h-5 w-5" />
        ) : (
          <Circle className="h-5 w-5" />
        )}
      </button>

      {/* Raw <button> for the same haptics reason as the checkoff above: a
          pressable would fire tap() on pointerdown and coalesce the success
          pulse. Sibling of the checkoff and Archive — never a wrapper, which
          would nest interactive elements. Its own aria-label keeps it from
          colliding with the checkoff's "Mark <title> complete". */}
      <button
        type="button"
        aria-label={`Complete ${chore.title}`}
        onClick={toggleCompletion}
        className="flex min-h-11 min-w-0 flex-1 flex-col justify-center text-left"
      >
        <span
          className={cn(
            "truncate text-sm font-semibold text-foreground",
            chore.completed && "text-muted-foreground line-through",
          )}
        >
          {chore.title}
        </span>
        {showCadence && (
          <span className="mt-1 text-xs font-medium text-muted-foreground">
            {cadenceLabel(chore.cadence)}
          </span>
        )}
      </button>

      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        aria-label={`Archive ${chore.title}`}
        onClick={onArchive}
        className="text-muted-foreground hover:text-foreground"
      >
        <Archive className="h-4 w-4" />
      </Button>
    </div>
  );
}

export type { ChoreRowProps };
