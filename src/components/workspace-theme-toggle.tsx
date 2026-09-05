import { SunMoon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function WorkspaceThemeToggle({ onToggle }: { onToggle: () => void }) {
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={onToggle}
      aria-label="Toggle color theme"
      title="Toggle color theme"
    >
      <SunMoon className="h-4 w-4" aria-hidden="true" />
      <span className="hidden sm:inline">Theme</span>
    </Button>
  );
}
