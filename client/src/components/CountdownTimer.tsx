import { useEffect, useState } from "react";
import { Clock } from "lucide-react";

interface CountdownTimerProps {
  expiresAt: number;
  className?: string;
}

export function CountdownTimer({ expiresAt, className = "" }: CountdownTimerProps) {
  const [timeLeft, setTimeLeft] = useState(0);

  useEffect(() => {
    const updateTimer = () => {
      const remaining = Math.max(0, expiresAt - Date.now());
      setTimeLeft(remaining);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);

    return () => clearInterval(interval);
  }, [expiresAt]);

  const seconds = Math.floor(timeLeft / 1000);
  const minutes = Math.floor(seconds / 60);
  const displaySeconds = seconds % 60;

  const getColorClass = () => {
    if (seconds > 60) return "text-chart-4";
    if (seconds > 30) return "text-chart-5";
    return "text-destructive";
  };

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <Clock className={`h-4 w-4 ${getColorClass()}`} />
      <span className={`text-sm font-mono font-semibold ${getColorClass()}`} data-testid="text-countdown">
        {minutes}:{displaySeconds.toString().padStart(2, "0")}
      </span>
    </div>
  );
}
