import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@databricks/appkit-ui/react";
import { DownloadIcon } from "lucide-react";
import type { ExportFormat } from "../lib/export.js";

// Shared export affordance: a download button that opens a small menu of
// output formats. Reused for both the whole-conversation export (header,
// labelled) and per-message export (bubble action row, icon-only).

/** Menu entries, in display order. */
const FORMATS: ReadonlyArray<{ format: ExportFormat; label: string }> = [
  { format: "pdf", label: "PDF" },
  { format: "markdown", label: "Markdown" },
];

/**
 * Export dropdown. Fires {@link onExport} with the chosen
 * {@link ExportFormat}. `iconOnly` renders a compact icon trigger (used
 * inside message bubbles) with the label surfaced as a tooltip; the
 * default renders an icon + "Export" text button (used in the header).
 */
export const ExportMenu = ({
  onExport,
  iconOnly = false,
  tooltip = "Export",
}: {
  onExport: (format: ExportFormat) => void;
  iconOnly?: boolean;
  tooltip?: string;
}) => {
  const trigger = iconOnly ? (
    <Button type="button" size="icon" variant="ghost" className="size-7">
      <DownloadIcon className="size-3" />
    </Button>
  ) : (
    <Button type="button" size="sm" variant="outline" className="gap-1.5">
      <DownloadIcon className="size-3" />
      Export
    </Button>
  );

  return (
    <DropdownMenu>
      {iconOnly ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent align="end">
        {FORMATS.map(({ format, label }) => (
          <DropdownMenuItem key={format} onClick={() => onExport(format)}>
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
