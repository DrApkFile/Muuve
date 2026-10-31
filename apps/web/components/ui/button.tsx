import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Muuve buttons: the hero's solid ink and hairline-outline pills, plus soft paper and accent fills.
// Presses squash a little and spring back with a lemon glow (the glass lens marks selection).
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium tracking-[-0.01em] transition-[background,color,border-color,transform,box-shadow] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:pointer-events-none disabled:opacity-45 active:scale-[0.96] active:shadow-[0_0_22px_-4px_rgba(233,194,46,0.6)] motion-reduce:active:scale-100 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-ink text-cream hover:bg-ink/85",
        outline:
          "border-[1.4px] border-ink bg-transparent text-ink hover:bg-paper/80 active:bg-paper",
        soft: "border border-ink/10 bg-paper/80 text-ink shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] backdrop-blur hover:bg-paper",
        lemon: "bg-lemon-500 text-ink hover:bg-lemon-500/85",
        sage: "bg-sage-500 text-ink hover:bg-sage-500/85",
        ghost: "text-ink/70 hover:bg-ink/5 hover:text-ink",
        danger:
          "border-[1.4px] border-destructive/40 text-destructive hover:bg-destructive hover:text-cream",
        link: "h-auto rounded-none p-0 text-ink underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-9 px-4 text-[13px] [&_svg]:size-4",
        default: "h-11 px-5 text-[15px] [&_svg]:size-[18px]",
        lg: "h-14 px-7 text-base [&_svg]:size-5",
        icon: "h-11 w-11 [&_svg]:size-[18px]",
        "icon-sm": "h-9 w-9 [&_svg]:size-4",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : (type ?? "button")}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
