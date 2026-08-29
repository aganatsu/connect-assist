import { type KeyboardEvent, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type OverflowTextLines = 1 | 2 | 3;

interface OverflowTextProps {
  text: string;
  lines?: OverflowTextLines;
  className?: string;
}

const CLAMP_CLASS: Record<OverflowTextLines, string> = {
  1: "truncate",
  2: "line-clamp-2",
  3: "line-clamp-3",
};

/**
 * Keeps dense layouts compact while preserving an explicit path to the full
 * value. Hover/focus shows a tooltip; click, Enter, or Space expands inline.
 */
export function OverflowText({
  text,
  lines = 1,
  className,
}: OverflowTextProps) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => setExpanded(false), [text]);

  const toggle = () => setExpanded((value) => !value);
  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} full text: ${text}`}
          title={text}
          onClick={toggle}
          onKeyDown={handleKeyDown}
          className={cn(
            "min-w-0 max-w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            expanded
              ? "whitespace-pre-wrap break-words [overflow-wrap:anywhere] cursor-zoom-out"
              : `${
                CLAMP_CLASS[lines]
              } cursor-zoom-in hover:underline hover:decoration-dotted hover:underline-offset-2`,
            className,
          )}
        >
          {text}
        </span>
      </TooltipTrigger>
      {!expanded && (
        <TooltipContent className="max-h-[min(16rem,calc(100vh-2rem))] max-w-[min(32rem,calc(100vw-2rem))] overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          <p>{text}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Click to expand inline
          </p>
        </TooltipContent>
      )}
    </Tooltip>
  );
}
