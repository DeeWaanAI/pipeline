import { toast as sonnerToast } from "sonner";

interface ToastOptions {
  title: string;
  description?: string;
  variant?: "default" | "destructive";
  duration?: number;
}

export function useToast() {
  const toast = (opts: ToastOptions) => {
    if (opts.variant === "destructive") {
      sonnerToast.error(opts.title, {
        description: opts.description,
        duration: opts.duration ?? 4000,
      });
    } else {
      sonnerToast.success(opts.title, {
        description: opts.description,
        duration: opts.duration ?? 4000,
      });
    }
  };

  return { toast };
}
