import { Loader2Icon } from "lucide-react";
import type { HTMLAttributes } from "react";
import { cn } from "../lib/utils.js";

// Vendored from https://github.com/mastra-ai/ui-dojo/blob/main/src/components/ai-elements/loader.tsx
// (Apache-2.0), simplified to reuse the `Loader2Icon` from lucide-react
// rather than inlining the bespoke SVG.

export type LoaderProps = HTMLAttributes<HTMLDivElement> & {
  size?: number;
};

export const Loader = ({ className, size = 16, ...props }: LoaderProps) => (
  <div
    className={cn("inline-flex animate-spin items-center justify-center", className)}
    {...props}
  >
    <Loader2Icon size={size} />
  </div>
);
