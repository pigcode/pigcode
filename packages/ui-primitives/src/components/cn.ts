/** 拼接类名：条件类名、数组与对象都交给 clsx。 */
import { clsx, type ClassValue } from "clsx"

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs)
}
