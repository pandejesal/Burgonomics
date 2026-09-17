import { formatDistanceToNow, format } from "date-fns";

/**
 * Returns a relative time string (e.g. "5 minutes ago", "in 2 hours").
 */
export function getRelativeTime(dateInput: string | Date | number): string {
  if (!dateInput) return "";
  try {
    const date =
      typeof dateInput === "string" || typeof dateInput === "number"
        ? new Date(dateInput)
        : dateInput;
    if (isNaN(date.getTime())) return String(dateInput);
    return formatDistanceToNow(date, { addSuffix: true });
  } catch {
    return String(dateInput);
  }
}

/**
 * Formats a date into a standard readable format (e.g. "MMM dd, yyyy").
 */
export function formatDate(dateInput: string | Date | number, formatStr = "MMM dd, yyyy"): string {
  if (!dateInput) return "";
  try {
    const date =
      typeof dateInput === "string" || typeof dateInput === "number"
        ? new Date(dateInput)
        : dateInput;
    if (isNaN(date.getTime())) return String(dateInput);
    return format(date, formatStr);
  } catch {
    return String(dateInput);
  }
}

/**
 * Formats a date into a 12-hour time format (e.g. "02:30 PM").
 */
export function formatTime(dateInput: string | Date | number, formatStr = "hh:mm a"): string {
  if (!dateInput) return "";
  try {
    const date =
      typeof dateInput === "string" || typeof dateInput === "number"
        ? new Date(dateInput)
        : dateInput;
    if (isNaN(date.getTime())) return String(dateInput);
    return format(date, formatStr);
  } catch {
    return String(dateInput);
  }
}
