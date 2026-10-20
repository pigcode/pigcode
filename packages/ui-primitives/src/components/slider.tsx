/** 基于 Base UI Slider 的滑块组合。 */
import { Slider as BaseSlider } from "@base-ui/react/slider"
import type { ComponentProps } from "react"
import { cn } from "./cn"

export function SliderRoot({ className, ...props }: ComponentProps<typeof BaseSlider.Root>) {
  return <BaseSlider.Root className={cn("slider", className)} {...props} />
}

export function SliderControl({ className, ...props }: ComponentProps<typeof BaseSlider.Control>) {
  return <BaseSlider.Control className={cn("slider-control", className)} {...props} />
}

export function SliderTrack({ className, ...props }: ComponentProps<typeof BaseSlider.Track>) {
  return <BaseSlider.Track className={cn("slider-track", className)} {...props} />
}

export function SliderIndicator({
  className,
  ...props
}: ComponentProps<typeof BaseSlider.Indicator>) {
  return <BaseSlider.Indicator className={cn("slider-range", className)} {...props} />
}

export function SliderThumb({ className, ...props }: ComponentProps<typeof BaseSlider.Thumb>) {
  return <BaseSlider.Thumb className={cn("slider-thumb", className)} {...props} />
}

export function SliderValue({ className, ...props }: ComponentProps<typeof BaseSlider.Value>) {
  return <BaseSlider.Value className={cn("slider-value", className)} {...props} />
}

export const Slider = {
  Root: SliderRoot,
  Control: SliderControl,
  Track: SliderTrack,
  Indicator: SliderIndicator,
  Thumb: SliderThumb,
  Value: SliderValue,
}
